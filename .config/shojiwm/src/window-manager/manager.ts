import {
  createWindowStack,
  read,
  COMPOSITOR,
  type OutputChangeEvent,
  type PointerMoveEvent,
  type ReadonlySignal,
  type WaylandWindow,
  type WindowActivateRequestEvent,
  type WindowFullscreenRequestEvent,
  type WindowMaximizeRequestEvent,
  type WindowMinimizeRequestEvent,
  type WindowMoveEvent,
  type WindowResizeEvent,
} from "shoji_wm";
import type { ManagedWindowRect } from "shoji_wm/types";
import { playRectAnimation, stopRectAnimation } from "./rect-animation";
import { hotReloadDebug } from "./debug";
import {
  averageOr,
  clamp,
  constrainedMax,
  insetRect,
  managedRectContainsPoint,
  resizeOriginForAxis,
  workspaceKey,
} from "./geometry";
import {
  isBottomSnapZone,
  isLayoutSnapZone,
  isLeftSnapZone,
  isRightSnapZone,
  isTopSnapZone,
  snapColumn,
  snapZonesConflict,
} from "./snap-zones";
import {
  MAXIMIZED_WINDOW_PADDING,
  OPEN_CLOSE_ANIMATION_DURATION,
  SNAP_CORNER_PX,
  SNAP_EDGE_PX,
  SNAP_GAP_PX,
  TILE_DRAG_WORKSPACE_EDGE_PX,
  TILE_DRAG_WORKSPACE_SWITCH_INTERVAL_MS,
  TITLEBAR_HEIGHT,
  UNMAXIMIZE_GRAB_ANIMATION_DURATION,
  WINDOW_BORDER_PX,
  WINDOW_MANAGEMENT_ANIMATION_DURATION,
  WINDOW_MANAGEMENT_EASING,
  WINDOW_STATE_FULLSCREEN,
  WINDOW_STATE_FULLSCREEN_RESTORE_RECT,
  WINDOW_STATE_MAXIMIZED,
  WINDOW_STATE_MINIMIZE_VISUAL_IDLE,
  WINDOW_STATE_MINIMIZED,
  WINDOW_STATE_RECT,
  WINDOW_STATE_RESTORE_RECT,
  WINDOW_STATE_SNAP_MONITOR,
  WINDOW_STATE_SNAP_ZONE,
  WINDOW_STATE_TILE_DRAGGING,
  WINDOW_STATE_WORKSPACE_OFFSET_Y,
  type FloatingSnapLayout,
  type WindowManagerSnapshot,
  type LayoutSnapZone,
  type ColumnConfig,
  type SnapPreviewBroadcaster,
  type SnapZone,
  type WorkspaceChangeBroadcaster,
  type WorkspacesView,
  type WorkspacesViewMonitor,
  type WorkspacesViewWorkspace,
  type WorkspacesViewWindow,
} from "./state";
import {
  markWindowCompositionDirty,
  scheduleCloseAnimation,
  scheduleMinimizeAnimation,
  scheduleOpenAnimation,
  withManagedWindowOnlySSDRebuildSuppressed,
} from "./lifecycle-animation";
import { Workspace } from "./workspace";

export class WindowManager {
  private readonly workspaces = new Map<string, Workspace>();
  private readonly activeWorkspaceByMonitor = new Map<string, number>();
  private readonly windowStack = createWindowStack();
  private readonly naturalRootRect: (rect: WaylandWindow) => ManagedWindowRect;
  // Tracks MRU focus time per window id so the dock can pick "the most recent
  // window of an app" deterministically. Updated by recordFocus().
  private readonly lastFocusedAt = new Map<string, number>();
  private readonly pendingInitialFocusByWindowId = new Map<string, number>();
  private currentMonitor: string;
  private isGrabbing = false;
  private tileDrag: {
    window: WaylandWindow;
    workspace: Workspace;
    lastWorkspaceSwitchAt: number;
  } | null = null;
  private floatingDrag: {
    window: WaylandWindow;
    workspace: Workspace;
    lastWorkspaceSwitchAt: number;
  } | null = null;
  private maximizedMoveDrag: {
    windowId: string;
    width: number;
    height: number;
  } | null = null;
  private lastPointerPosition: PointerMoveEvent["position"] | null = null;
  private lastPointerTarget: PointerMoveEvent["target"] = { kind: "none" };
  // Broadcasts the active snap-zone preview rect to external clients (the bar).
  private snapPreviewBroadcaster: SnapPreviewBroadcaster | null = null;
  private workspaceChangeBroadcaster: WorkspaceChangeBroadcaster | null = null;
  // Pending Windows-style snap decision for the in-flight floating drag.
  private floatingSnap: {
    windowId: string;
    monitor: string;
    zone: SnapZone;
    rect: ManagedWindowRect;
  } | null = null;

  private maxColumns: ColumnConfig = 1;

  public constructor(
    naturalRootRect: (rect: WaylandWindow) => ManagedWindowRect,
  ) {
    this.currentMonitor = "";
    this.naturalRootRect = naturalRootRect;
    this.syncWorkspaces();
  }

  // Per-monitor column count (flat number or table keyed by output name).
  public configureColumns(maxColumns: ColumnConfig): void {
    this.maxColumns = maxColumns;
  }

  private resolveMaxColumns(monitor: string): number {
    if (typeof this.maxColumns === "object") {
      return this.maxColumns[monitor] ?? 1;
    }
    return this.maxColumns;
  }

  public onPointerMove(event: PointerMoveEvent) {
    this.syncWorkspaces();
    this.currentMonitor = event.outputName ?? this.currentMonitor;
    this.lastPointerPosition = event.position;
    this.lastPointerTarget = event.target;
    this.focusWindowAtPointerTarget(event.target, event.outputName);
  }

  public onOutputChange(event: OutputChangeEvent) {
    const liveMonitors = new Set(
      event.outputs
        .filter((output) => output.enabled)
        .map((output) => output.name),
    );
    if (liveMonitors.size === 0) {
      return;
    }

    const fallbackMonitor =
      (this.currentMonitor && liveMonitors.has(this.currentMonitor)
        ? this.currentMonitor
        : undefined) ?? Array.from(liveMonitors)[0];
    if (!fallbackMonitor) {
      return;
    }

    const orphanedWorkspaces = Array.from(this.workspaces.values()).filter(
      (workspace) => !liveMonitors.has(workspace.monitor),
    );
    if (orphanedWorkspaces.length === 0) {
      this.syncWorkspaces();
      this.refreshUsableAreaLayouts();
      return;
    }

    const orphanedActiveWorkspaceByMonitor = new Map(
      Array.from(this.activeWorkspaceByMonitor.entries()).filter(
        ([monitor]) => !liveMonitors.has(monitor),
      ),
    );

    for (const monitor of Array.from(this.activeWorkspaceByMonitor.keys())) {
      if (!liveMonitors.has(monitor)) {
        this.activeWorkspaceByMonitor.delete(monitor);
      }
    }

    for (const workspace of orphanedWorkspaces) {
      const oldKey = workspaceKey(workspace.monitor, workspace.index);
      this.workspaces.delete(oldKey);

      if (workspace.windowCount() === 0) {
        continue;
      }

      const targetMonitor = fallbackMonitor;
      const targetIndex = this.availableWorkspaceIndex(
        targetMonitor,
        workspace.index,
      );
      const wasActiveOnRemovedMonitor =
        orphanedActiveWorkspaceByMonitor.get(workspace.monitor) ===
        workspace.index;
      workspace.moveToMonitor(targetMonitor, targetIndex);
      this.workspaces.set(workspaceKey(targetMonitor, targetIndex), workspace);
      if (
        wasActiveOnRemovedMonitor ||
        !this.activeWorkspaceByMonitor.has(targetMonitor)
      ) {
        this.activeWorkspaceByMonitor.set(targetMonitor, targetIndex);
      }
      workspace.setVisible(workspace.isActive());
      workspace.applyLayout({
        suppressSSDRebuild: false,
        animate: false,
        preserveMissingActive: true,
      });
    }

    if (!liveMonitors.has(this.currentMonitor)) {
      this.currentMonitor = fallbackMonitor;
    }
    this.syncWorkspaces();
    this.refreshUsableAreaLayouts();
    this.syncWorkspaceVisibility();
  }

  public onOpen(window: WaylandWindow) {
    window.focus();
    this.windowStack.add(window);

    window.setCloseAnimationDuration(OPEN_CLOSE_ANIMATION_DURATION);
  }

  public snapshot(): WindowManagerSnapshot {
    const snapshot = {
      currentMonitor: this.currentMonitor,
      activeWorkspaceByMonitor: Array.from(
        this.activeWorkspaceByMonitor.entries(),
      ),
      workspaces: Array.from(this.workspaces.values()).map((workspace) =>
        workspace.snapshot(),
      ),
    };
    hotReloadDebug("hybrid-snapshot", {
      currentMonitor: snapshot.currentMonitor,
      workspaceCount: snapshot.workspaces.length,
      workspaces: snapshot.workspaces.map((workspace) => ({
        monitor: workspace.monitor,
        index: workspace.index,
        isTiled: workspace.isTiled,
        activeWindowId: workspace.activeWindowId,
        windowIds: workspace.windows.map((window) => window.id),
      })),
    });
    return snapshot;
  }

  public restore(snapshot: WindowManagerSnapshot) {
    hotReloadDebug("hybrid-restore", {
      currentMonitor: snapshot.currentMonitor,
      workspaceCount: snapshot.workspaces.length,
      workspaces: snapshot.workspaces.map((workspace) => ({
        monitor: workspace.monitor,
        index: workspace.index,
        isTiled: workspace.isTiled,
        activeWindowId: workspace.activeWindowId,
        windowIds: workspace.windows.map((window) => window.id),
      })),
    });
    this.currentMonitor = snapshot.currentMonitor;
    this.activeWorkspaceByMonitor.clear();
    for (const [monitor, index] of snapshot.activeWorkspaceByMonitor) {
      this.activeWorkspaceByMonitor.set(monitor, index);
    }
    this.workspaces.clear();
    for (const workspaceSnapshot of snapshot.workspaces) {
      const workspace = this.ensureWorkspace(
        workspaceSnapshot.monitor,
        workspaceSnapshot.index,
      );
      workspace.restore(workspaceSnapshot);
    }
  }

  public onFirstCommit(window: WaylandWindow) {
    if (!this.windowStack.has(window)) {
      this.windowStack.add(window, { at: "back" });
    }
    window.setCloseAnimationDuration(OPEN_CLOSE_ANIMATION_DURATION);

    let restoredExistingWindow = false;
    const workspace =
      this.findWorkspaceRestoringWindow(window) ?? this.getCurrentWorkspace();
    if (workspace) {
      restoredExistingWindow = workspace.addWindow(window);
      if (
        !restoredExistingWindow &&
        workspace.isTiled &&
        workspace.shouldTile(window)
      ) {
        this.trackPendingInitialFocus(window);
      }
      this.applyWorkspaceStackPolicy(workspace);
      this.syncWorkspaceVisibility();
    } else {
      window.state[WINDOW_STATE_RECT].set(this.naturalRootRect(window));
    }

    if (window.isMaximized()) {
      window.state[WINDOW_STATE_RESTORE_RECT].set(
        this.initialRestoreRectForMaximizedWindow(window),
      );
      window.state[WINDOW_STATE_RECT].set(this.maximizedRectForWindow(window));
      window.state[WINDOW_STATE_MAXIMIZED].set(true);
    }
    if (!restoredExistingWindow) {
      scheduleOpenAnimation(window);
    }
    hotReloadDebug("hybrid-first-commit", {
      windowId: window.id,
      title: window.title.peek(),
      workspace: workspace
        ? { monitor: workspace.monitor, index: workspace.index }
        : null,
      restoredExistingWindow,
      scheduledOpenAnimation: !restoredExistingWindow,
    });
  }

  public onStartClose(window: WaylandWindow) {
    scheduleCloseAnimation(window);

    for (const workspace of this.workspaces.values()) {
      const nextFocus = workspace.removeWindow(window);
      if (nextFocus !== undefined) {
        workspace.applyLayout();
        nextFocus?.focus();
        break;
      }
    }
    this.syncWorkspaceVisibility();
  }

  public onClose(window: WaylandWindow) {
    this.windowStack.remove(window);
    for (const workspace of this.workspaces.values()) {
      if (workspace.removeWindow(window) !== undefined) {
        workspace.applyLayout();
      }
    }
    this.syncWorkspaceVisibility();
  }

  public onFocus(window: WaylandWindow, focused: boolean) {
    if (focused) {
      this.windowStack.raise(window);
      const workspace = this.findWorkspaceForWindow(window);
      if (this.shouldDeferFocusLayoutForInitialOpen(window, workspace)) {
        this.applyWorkspaceStackPolicy(workspace);
        return;
      }
      if (workspace?.isTiled && workspace.isActive()) {
        workspace.focusWindow(window);
        this.applyWorkspaceStackPolicy(workspace);
      }
    }
  }

  public onWindowResize(event: WindowResizeEvent) {
    if (!read(event.window.isResizable)) {
      return;
    }

    const workspace = this.findWorkspaceForWindow(event.window);
    if (event.phase === "start" || event.phase === "update") {
      this.beginInteractiveUnmaximize(event.window);
    }

    if (workspace?.isTiled && workspace.shouldTile(event.window)) {
      workspace.resizeTile(event);
      this.applyWorkspaceStackPolicy(workspace);
      return;
    }

    const nextRect = this.constrainResizeRect(event);
    if (workspace && this.resizeFloatingSnapLayout(event, workspace, nextRect)) {
      this.applyWorkspaceStackPolicy(workspace);
      return;
    }

    stopRectAnimation(event.window, WINDOW_STATE_RECT);
    event.window.state[WINDOW_STATE_RECT].set(nextRect);
    workspace?.syncFloatingWindowRect(event.window, nextRect);
    this.applyWorkspaceStackPolicy(workspace);
  }

  public onWindowMove(event: WindowMoveEvent) {
    const workspace = this.findWorkspaceForWindow(event.window);
    if (workspace?.isTiled && workspace.shouldTile(event.window)) {
      this.onTileWindowMove(event, workspace);
      this.applyWorkspaceStackPolicy(workspace);
      return;
    }

    if (workspace) {
      this.onFloatingWindowMove(event, workspace);
      return;
    }

    const window = event.window;
    if (event.phase === "start" && window.state[WINDOW_STATE_MAXIMIZED]()) {
      const restoreRect =
        window.state[WINDOW_STATE_RESTORE_RECT]() ?? event.currentRect;
      this.maximizedMoveDrag = {
        windowId: window.id,
        width: read(restoreRect.width),
        height: read(restoreRect.height),
      };
      this.beginInteractiveUnmaximize(window);
    }
    if (event.phase === "start") {
      this.isGrabbing = true;
      this.clearWindowSnapState(window);
    }

    const maximizedMoveDrag =
      this.maximizedMoveDrag?.windowId === window.id
        ? this.maximizedMoveDrag
        : null;
    if (maximizedMoveDrag) {
      const nextRect = this.restoreRectForMaximizedMove(
        event,
        maximizedMoveDrag.width,
        maximizedMoveDrag.height,
      );
      if (event.phase === "start") {
        playRectAnimation(
          window,
          WINDOW_STATE_RECT,
          nextRect,
          WINDOW_MANAGEMENT_EASING,
          UNMAXIMIZE_GRAB_ANIMATION_DURATION,
        );
      } else {
        stopRectAnimation(window, WINDOW_STATE_RECT);
        window.state[WINDOW_STATE_RECT].set(nextRect);
      }
      if (event.phase === "end") {
        this.isGrabbing = false;
        this.maximizedMoveDrag = null;
        this.finishFloatingDragSnap(event, workspace);
      } else if (event.phase === "cancel") {
        this.isGrabbing = false;
        this.maximizedMoveDrag = null;
        this.finishFloatingDragSnap(event, workspace);
      } else {
        this.updateFloatingDragSnap(event);
      }
      return;
    }

    if (event.phase === "end" || event.phase === "cancel") {
      this.isGrabbing = false;
      const snapped = this.finishFloatingDragSnap(event, workspace);
      if (!snapped) {
        stopRectAnimation(window, WINDOW_STATE_RECT);
        window.state[WINDOW_STATE_RECT].set(event.currentRect);
      }
      this.applyWorkspaceStackPolicy(workspace);
      return;
    }

    this.updateFloatingDragSnap(event);
    stopRectAnimation(window, WINDOW_STATE_RECT);
    window.state[WINDOW_STATE_RECT].set(event.currentRect);
    this.applyWorkspaceStackPolicy(workspace);
  }

  private onFloatingWindowMove(event: WindowMoveEvent, workspace: Workspace) {
    const window = event.window;
    if (
      event.phase === "start" ||
      !this.floatingDrag ||
      this.floatingDrag.window.id !== window.id
    ) {
      this.isGrabbing = true;
      this.floatingDrag = {
        window,
        workspace,
        lastWorkspaceSwitchAt: event.timestamp,
      };
      if (window.state[WINDOW_STATE_MAXIMIZED]()) {
        const restoreRect =
          window.state[WINDOW_STATE_RESTORE_RECT]() ?? event.currentRect;
        this.maximizedMoveDrag = {
          windowId: window.id,
          width: read(restoreRect.width),
          height: read(restoreRect.height),
        };
        this.beginInteractiveUnmaximize(window);
      }
      this.clearWindowSnapState(window);
    }

    const drag = this.floatingDrag;
    if (!drag) {
      return;
    }

    const maximizedMoveDrag =
      this.maximizedMoveDrag?.windowId === window.id
        ? this.maximizedMoveDrag
        : null;
    const nextRect: ManagedWindowRect = maximizedMoveDrag
      ? this.restoreRectForMaximizedMove(
          event,
          maximizedMoveDrag.width,
          maximizedMoveDrag.height,
        )
      : event.currentRect;

    if (maximizedMoveDrag && event.phase === "start") {
      playRectAnimation(
        window,
        WINDOW_STATE_RECT,
        nextRect,
        WINDOW_MANAGEMENT_EASING,
        UNMAXIMIZE_GRAB_ANIMATION_DURATION,
      );
    } else {
      stopRectAnimation(window, WINDOW_STATE_RECT);
      window.state[WINDOW_STATE_RECT].set(nextRect);
    }

    if (event.phase !== "cancel") {
      const targetWorkspace = this.workspaceForFloatingDrag(event, drag);
      if (targetWorkspace !== drag.workspace) {
        drag.workspace.removeFloatingWindow(window);
        drag.workspace.applyLayout();
        if (targetWorkspace.isTiled && targetWorkspace.shouldTile(window)) {
          this.clearFloatingSnapPreview();
          targetWorkspace.adoptTileDragWindow(window, nextRect);
          drag.workspace = targetWorkspace;
          this.floatingDrag = null;
          this.tileDrag = {
            window,
            workspace: targetWorkspace,
            lastWorkspaceSwitchAt: event.timestamp,
          };
          this.syncWorkspaceVisibility();
          targetWorkspace.updateTileDrag(
            window,
            nextRect,
            event.currentPointer.x,
          );
          this.emitSnapPreview(
            targetWorkspace.monitor,
            targetWorkspace.draggingSlotRect(),
            "tiling",
          );
          this.applyWorkspaceStackPolicy(targetWorkspace);
          if (event.phase === "end") {
            targetWorkspace.endTileDrag(window, false);
            this.tileDrag = null;
            this.maximizedMoveDrag = null;
            this.isGrabbing = false;
          }
          window.focus();
          return;
        }
        targetWorkspace.adoptFloatingWindow(window, nextRect);
        drag.workspace = targetWorkspace;
        this.syncWorkspaceVisibility();
        window.focus();
      } else {
        targetWorkspace.syncFloatingWindowRect(window, nextRect);
      }

      this.applyWorkspaceStackPolicy(targetWorkspace);
      this.updateFloatingDragSnap(event);
    }

    if (event.phase === "end" || event.phase === "cancel") {
      const snapped = this.finishFloatingDragSnap(event, drag.workspace);
      if (!snapped) {
        stopRectAnimation(window, WINDOW_STATE_RECT);
        window.state[WINDOW_STATE_RECT].set(nextRect);
        drag.workspace.syncFloatingWindowRect(window, nextRect);
      }
      this.applyWorkspaceStackPolicy(drag.workspace);
      this.floatingDrag = null;
      if (maximizedMoveDrag) {
        this.maximizedMoveDrag = null;
      }
      this.isGrabbing = false;
    }
  }

  private onTileWindowMove(event: WindowMoveEvent, workspace: Workspace) {
    const window = event.window;
    if (
      event.phase === "start" ||
      !this.tileDrag ||
      this.tileDrag.window.id !== window.id
    ) {
      this.isGrabbing = true;
      workspace.beginTileDrag(window, event.currentRect);
      this.tileDrag = {
        window,
        workspace,
        lastWorkspaceSwitchAt: event.timestamp,
      };
    }

    const drag = this.tileDrag;
    if (!drag) {
      return;
    }

    if (event.phase === "end" || event.phase === "cancel") {
      this.emitSnapPreview(drag.workspace.monitor, null, "tiling");
      drag.workspace.endTileDrag(window, event.phase === "cancel");
      this.tileDrag = null;
      this.isGrabbing = false;
      return;
    }

    let targetWorkspace = this.workspaceForTileDrag(event, drag);
    if (targetWorkspace !== drag.workspace) {
      this.emitSnapPreview(drag.workspace.monitor, null, "tiling");
      drag.workspace.removeTileDragWindow(window);
      drag.workspace.applyLayout();
      if (!targetWorkspace.isTiled || !targetWorkspace.shouldTile(window)) {
        window.state[WINDOW_STATE_TILE_DRAGGING].set(false);
        targetWorkspace.adoptFloatingWindow(window, event.currentRect);
        this.tileDrag = null;
        this.floatingDrag = {
          window,
          workspace: targetWorkspace,
          lastWorkspaceSwitchAt: event.timestamp,
        };
        this.syncWorkspaceVisibility();
        this.applyWorkspaceStackPolicy(targetWorkspace);
        this.updateFloatingDragSnap(event);
        return;
      }
      targetWorkspace.adoptTileDragWindow(window, event.currentRect);
      drag.workspace = targetWorkspace;
      this.syncWorkspaceVisibility();
    }

    targetWorkspace.updateTileDrag(
      window,
      event.currentRect,
      event.currentPointer.x,
    );
    this.emitSnapPreview(
      targetWorkspace.monitor,
      targetWorkspace.draggingSlotRect(),
      "tiling",
    );
  }

  public onWindowMaximizeRequest(event: WindowMaximizeRequestEvent) {
    const workspace = this.findWorkspaceForWindow(event.window);
    if (this.isGrabbing) {
      return;
    }

    const window = event.window;
    window.state[WINDOW_STATE_MINIMIZED].set(false);
    this.clearWindowSnapState(window);

    if (workspace?.isTiled && workspace.shouldTile(window)) {
      if (!event.maximized) {
        window.state[WINDOW_STATE_RESTORE_RECT].set(null);
        window.state[WINDOW_STATE_MAXIMIZED].set(false);
        workspace.applyLayout();
        this.applyWorkspaceStackPolicy(workspace);
        return;
      }

      window.state[WINDOW_STATE_RESTORE_RECT].set(null);
      window.state[WINDOW_STATE_MAXIMIZED].set(true);
      workspace.focusWindow(window);
      workspace.applyLayout();
      this.applyWorkspaceStackPolicy(workspace);
      window.focus();
      return;
    }

    if (!event.maximized) {
      const restoreRect = window.state[WINDOW_STATE_RESTORE_RECT]();
      if (restoreRect) {
        workspace?.syncFloatingWindowRect(window, restoreRect);
        playRectAnimation(
          window,
          WINDOW_STATE_RECT,
          restoreRect,
          WINDOW_MANAGEMENT_EASING,
          WINDOW_MANAGEMENT_ANIMATION_DURATION,
        );
      }
      window.state[WINDOW_STATE_RESTORE_RECT].set(null);
      window.state[WINDOW_STATE_MAXIMIZED].set(false);
      return;
    }

    if (!window.state[WINDOW_STATE_MAXIMIZED]()) {
      const currentRect = window.state[WINDOW_STATE_RECT]();
      const currentWidth = read(currentRect.width);
      const currentHeight = read(currentRect.height);
      if (currentWidth > 1 && currentHeight > 1) {
        window.state[WINDOW_STATE_RESTORE_RECT].set(currentRect);
      }
    }
    const maximizedRect = this.maximizedRectForWindow(window);
    workspace?.syncFloatingWindowRect(window, maximizedRect);
    playRectAnimation(
      window,
      WINDOW_STATE_RECT,
      maximizedRect,
      WINDOW_MANAGEMENT_EASING,
      WINDOW_MANAGEMENT_ANIMATION_DURATION,
    );
    window.state[WINDOW_STATE_MAXIMIZED].set(true);
    this.applyWorkspaceStackPolicy(workspace);
  }

  public onWindowMinimizeRequest(event: WindowMinimizeRequestEvent) {
    const wasMinimized = event.window.state[WINDOW_STATE_MINIMIZED]();
    const workspace = this.findWorkspaceForWindow(event.window);
    if (wasMinimized !== event.minimized) {
      stopRectAnimation(event.window, WINDOW_STATE_RECT);
      if (!event.minimized) {
        event.window.state[WINDOW_STATE_MINIMIZE_VISUAL_IDLE].set(false);
      }
      event.window.state[WINDOW_STATE_MINIMIZED].set(event.minimized);
      if (event.minimized) {
        event.window.state[WINDOW_STATE_MINIMIZE_VISUAL_IDLE].set(true);
      }
      markWindowCompositionDirty(event.window);
      scheduleMinimizeAnimation(event.window, event.minimized);
    }
    if (workspace?.isTiled) {
      if (!event.minimized && workspace.shouldTile(event.window)) {
        workspace.focusWindow(event.window);
      } else {
        workspace.applyLayout();
      }
      this.applyWorkspaceStackPolicy(workspace);
    }
  }

  public onWindowActivateRequest(event: WindowActivateRequestEvent) {
    const wasMinimized = event.window.state[WINDOW_STATE_MINIMIZED]();
    if (wasMinimized) {
      this.onWindowMinimizeRequest({
        window: event.window,
        minimized: false,
        source:
          event.source === "xdg-activation" ||
          event.source === "xwayland" ||
          event.source === "keybind"
            ? event.source
            : "api",
        timestamp: event.timestamp,
      });
    }
    const workspace = this.findWorkspaceForWindow(event.window);
    if (workspace) {
      // If the window is on another workspace, switch with the same
      // slide/fade animation as keyboard switching (no-op if same).
      this.switchWorkspaceTo(workspace.monitor, workspace.index, {
        focusActiveAfter: false,
      });
    }
    // Focus the target window after switching (overrides switchWorkspaceTo's focusActiveWindow).
    event.window.focus();
  }

  public toggleCurrentWorkspaceTiling() {
    withManagedWindowOnlySSDRebuildSuppressed(() => {
      const workspace = this.getCurrentWorkspace();
      if (!workspace) {
        return;
      }
      workspace.setTiled(!workspace.isTiled);
      this.applyWorkspaceStackPolicy(workspace);
    });
  }

  public toggleWorkspaceTilingForMonitor(monitor: string) {
    withManagedWindowOnlySSDRebuildSuppressed(() => {
      this.syncWorkspaces();
      const workspace = this.workspaceForMonitor(monitor);
      if (!workspace) {
        return;
      }
      workspace.setTiled(!workspace.isTiled);
      this.applyWorkspaceStackPolicy(workspace);
    });
  }

  // Column controls: bump/toggle_strict/reset/toggle_monocle_or_maximize,
  // operating on the active monitor's current workspace.
  public bumpColumns(delta: number): number | undefined {
    const workspace = this.getCurrentWorkspace();
    if (!workspace) {
      return undefined;
    }
    const next = workspace.bumpColumns(delta);
    workspace.applyLayout();
    return next;
  }

  public toggleStrictColumns(): boolean | undefined {
    const workspace = this.getCurrentWorkspace();
    if (!workspace) {
      return undefined;
    }
    const next = workspace.toggleStrictColumns();
    workspace.applyLayout();
    return next;
  }

  public resetColumnLayout(): void {
    const workspace = this.getCurrentWorkspace();
    if (!workspace) {
      return;
    }
    workspace.resetColumnLayout();
    workspace.applyLayout();
  }

  // SUPER+F: monocle within the column layout when the workspace is tiled, otherwise
  // fall back to the WM's normal maximize toggle.
  public toggleMonocleOrMaximize(): void {
    const workspace = this.getCurrentWorkspace();
    if (workspace?.isTiled) {
      const changed = workspace.toggleMonocleForActiveWindow();
      if (changed !== undefined) {
        workspace.applyLayout();
        return;
      }
    }
    this.toggleFocusedWindowMaximize();
  }

  public toggleFocusedWindowFloat(): void {
    const workspace = this.getCurrentWorkspace();
    if (!workspace) {
      return;
    }
    const changed = workspace.toggleForcedFloatForActiveWindow();
    if (changed !== undefined) {
      this.applyWorkspaceStackPolicy(workspace);
    }
  }

  public focusTile(direction: -1 | 1) {
    withManagedWindowOnlySSDRebuildSuppressed(() => {
      const workspace = this.getCurrentWorkspace();
      if (!workspace?.isTiled) {
        return;
      }
      workspace.focusRelative(direction);
      this.applyWorkspaceStackPolicy(workspace);
    });
  }

  public moveFocusedTile(direction: -1 | 1) {
    withManagedWindowOnlySSDRebuildSuppressed(() => {
      const workspace = this.getCurrentWorkspace();
      if (!workspace?.isTiled) {
        return;
      }
      if (!workspace.moveFocusedTile(direction)) {
        return;
      }
      this.applyWorkspaceStackPolicy(workspace);
    });
  }

  public moveFocusedWindowToWorkspace(direction: -1 | 1) {
    withManagedWindowOnlySSDRebuildSuppressed(() => {
      this.syncWorkspaces();
      const focused = this.findFocusedWorkspaceWindow();
      if (!focused) {
        return;
      }
      const targetIndex = Math.max(1, focused.workspace.index + direction);
      this.relocateWindowToWorkspace(
        focused.workspace,
        focused.window,
        targetIndex,
      );
    });
  }

  // Move the focused window to an absolute local workspace number on its
  // current monitor, as opposed to moveFocusedWindowToWorkspace's relative
  // +/-1 step.
  public moveFocusedWindowToWorkspaceIndex(targetIndex: number) {
    this.moveWindowToWorkspaceIndex(undefined, targetIndex);
  }

  // Move a specific window (or the focused one, if windowId is omitted) to
  // an absolute local workspace number. `follow: false` moves the window
  // without switching to or focusing its new workspace — used by the IPC
  // `window/move` "q" (quiet) flag.
  public moveWindowToWorkspaceIndex(
    windowId: string | undefined,
    targetIndex: number,
    follow = true,
  ) {
    withManagedWindowOnlySSDRebuildSuppressed(() => {
      this.syncWorkspaces();
      const target = windowId
        ? this.findWorkspaceAndWindowById(windowId)
        : this.findFocusedWorkspaceWindow();
      if (!target) {
        return;
      }
      this.relocateWindowToWorkspace(
        target.workspace,
        target.window,
        targetIndex,
        follow,
      );
    });
  }

  // Swap every window between the active workspace and a target local
  // workspace number. No need to stage the swap through a temp workspace —
  // both Workspace objects are mutated directly and synchronously.
  public swapActiveWorkspaceWith(targetIndex: number) {
    withManagedWindowOnlySSDRebuildSuppressed(() => {
      const fromWorkspace = this.getCurrentWorkspace();
      if (
        !fromWorkspace ||
        targetIndex === fromWorkspace.index ||
        targetIndex < 1
      ) {
        return;
      }
      const monitor = fromWorkspace.monitor;
      const targetWorkspace = this.ensureWorkspace(monitor, targetIndex);
      const fromWindows = fromWorkspace.listWindows();
      const targetWindows = targetWorkspace.listWindows();

      for (const window of fromWindows) {
        const moved = fromWorkspace.takeWindowForMove(window);
        if (moved) {
          targetWorkspace.addMovedWindow(window, moved.snapshot);
        }
      }
      for (const window of targetWindows) {
        const moved = targetWorkspace.takeWindowForMove(window);
        if (moved) {
          fromWorkspace.addMovedWindow(window, moved.snapshot);
        }
      }

      fromWorkspace.applyLayout();
      targetWorkspace.applyLayout();
      this.switchWorkspaceTo(monitor, targetIndex);
      this.applyWorkspaceStackPolicy(fromWorkspace);
      this.applyWorkspaceStackPolicy(targetWorkspace);
      this.syncWorkspaceVisibility();
    });
  }

  // Move every window from the active workspace into a target local
  // workspace number, then switch to it. One-directional version of
  // swapActiveWorkspaceWith — nothing moves back the other way.
  public moveWorkspaceInto(targetIndex: number) {
    withManagedWindowOnlySSDRebuildSuppressed(() => {
      const fromWorkspace = this.getCurrentWorkspace();
      if (
        !fromWorkspace ||
        targetIndex === fromWorkspace.index ||
        targetIndex < 1
      ) {
        return;
      }
      const monitor = fromWorkspace.monitor;
      const targetWorkspace = this.ensureWorkspace(monitor, targetIndex);
      const fromWindows = fromWorkspace.listWindows();

      for (const window of fromWindows) {
        const moved = fromWorkspace.takeWindowForMove(window);
        if (moved) {
          targetWorkspace.addMovedWindow(window, moved.snapshot);
        }
      }

      fromWorkspace.applyLayout();
      targetWorkspace.applyLayout();
      this.switchWorkspaceTo(monitor, targetIndex);
      this.applyWorkspaceStackPolicy(fromWorkspace);
      this.applyWorkspaceStackPolicy(targetWorkspace);
      this.syncWorkspaceVisibility();
    });
  }

  private findFocusedWorkspaceWindow():
    | { workspace: Workspace; window: WaylandWindow }
    | undefined {
    for (const workspace of this.workspaces.values()) {
      const window = workspace.focusedWindow();
      if (window) {
        return { workspace, window };
      }
    }
    return undefined;
  }

  private findWorkspaceAndWindowById(
    windowId: string,
  ): { workspace: Workspace; window: WaylandWindow } | undefined {
    const window = this.findWindowById(windowId);
    if (!window) {
      return undefined;
    }
    const workspace = this.findWorkspaceForWindow(window);
    if (!workspace) {
      return undefined;
    }
    return { workspace, window };
  }

  private relocateWindowToWorkspace(
    fromWorkspace: Workspace,
    window: WaylandWindow,
    targetIndex: number,
    follow = true,
  ) {
    if (targetIndex === fromWorkspace.index || targetIndex < 1) {
      return;
    }

    const targetWorkspace = this.ensureWorkspace(
      fromWorkspace.monitor,
      targetIndex,
    );
    const moved = fromWorkspace.takeWindowForMove(window);
    if (!moved) {
      return;
    }

    targetWorkspace.addMovedWindow(window, moved.snapshot);
    fromWorkspace.applyLayout();
    targetWorkspace.applyLayout();
    this.applyWorkspaceStackPolicy(fromWorkspace);
    this.applyWorkspaceStackPolicy(targetWorkspace);
    this.syncWorkspaceVisibility();

    if (!follow) {
      return;
    }
    this.switchWorkspaceTo(fromWorkspace.monitor, targetIndex, {
      focusActiveAfter: false,
    });
    if (targetWorkspace.isTiled) {
      targetWorkspace.panToWindow(window);
    }
    window.focus();
  }

  public closeFocusedWindow() {
    for (const workspace of this.workspaces.values()) {
      const focused = workspace.focusedWindow();
      if (focused) {
        focused.close();
        return;
      }
    }
  }

  // Close every window in scope: undefined = current workspace, "a" =
  // every workspace on every monitor, number = local index on the current
  // monitor. ("a" matches tiling.lua's Tiling.cw scope convention.)
  public closeWorkspaceWindows(scope?: number | "a") {
    this.syncWorkspaces();
    if (scope === "a") {
      for (const workspace of Array.from(this.workspaces.values())) {
        for (const window of workspace.listWindows()) {
          window.close();
        }
      }
      return;
    }
    const workspace =
      typeof scope === "number"
        ? this.ensureWorkspace(this.getCurrentMonitorName(), scope)
        : this.getCurrentWorkspace();
    if (!workspace) {
      return;
    }
    for (const window of workspace.listWindows()) {
      window.close();
    }
  }

  public toggleFocusedWindowMaximize() {
    for (const workspace of this.workspaces.values()) {
      const focused = workspace.focusedWindow();
      if (!focused || !read(focused.isResizable)) {
        continue;
      }

      if (focused.state[WINDOW_STATE_MAXIMIZED]()) {
        focused.unmaximize();
      } else {
        focused.maximize();
      }
      return;
    }
  }

  // Compositor-initiated fullscreen toggle (Super+Shift+F in the Hyprland
  // source) — there's no dedicated wrapper for this in the stock WM, only the
  // client-request handler below, so drive it through the same event shape
  // client requests use.
  public toggleFocusedWindowFullscreen() {
    for (const workspace of this.workspaces.values()) {
      const focused = workspace.focusedWindow();
      if (!focused) {
        continue;
      }
      this.onWindowFullscreenRequest({
        window: focused,
        fullscreen: !focused.state[WINDOW_STATE_FULLSCREEN](),
        outputName: this.currentMonitor,
        source: "keybind",
        timestamp: Date.now(),
      });
      return;
    }
  }

  public refreshUsableAreaLayouts() {
    this.syncWorkspaces();
    // While a window is being interactively dragged, do not re-apply the
    // usable-area layout. It would clobber the in-flight drag — most visibly,
    // a maximized window (which stays WINDOW_STATE_MAXIMIZED during the
    // unmaximize-grab) gets snapped back to its full rect, flashing maximized
    // whenever a layer surface mounts/unmounts (e.g. the snap-preview overlay).
    // The layout is re-applied by the next layout event once the drag ends.
    if (this.isGrabbing) {
      return;
    }
    for (const workspace of this.workspaces.values()) {
      workspace.refreshUsableAreaLayout();
    }
    this.syncWorkspaceVisibility();
  }

  public switchWorkspace(direction: -1 | 1) {
    const monitor = this.currentMonitor || COMPOSITOR.output.list.at(0);
    if (!monitor) {
      return;
    }
    const currentIndex = this.activeWorkspaceByMonitor.get(monitor) ?? 1;
    this.switchWorkspaceTo(monitor, Math.max(1, currentIndex + direction));
  }

  /**
   * Animated switch to an explicit workspace index on a monitor. Direction is
   * inferred from the current index so the same vertical slide/fade transition
   * as keyboard switching plays (used by the IPC `workspaces.activate`).
   */
  public switchWorkspaceTo(
    monitor: string,
    targetIndex: number,
    options: { focusActiveAfter?: boolean } = {},
  ) {
    this.syncWorkspaces();
    if (!monitor || targetIndex < 1) {
      return;
    }

    const currentIndex = this.activeWorkspaceByMonitor.get(monitor) ?? 1;
    if (targetIndex === currentIndex) {
      return;
    }
    const direction: -1 | 1 = targetIndex > currentIndex ? 1 : -1;

    const fromWorkspace = this.ensureWorkspace(monitor, currentIndex);
    const toWorkspace = this.ensureWorkspace(monitor, targetIndex);
    const distance = this.workspaceTransitionDistance(monitor);

    this.activeWorkspaceByMonitor.set(monitor, targetIndex);
    this.currentMonitor = monitor;

    for (const workspace of this.workspaces.values()) {
      if (workspace === fromWorkspace || workspace === toWorkspace) {
        continue;
      }
      workspace.setVisible(workspace.isActive());
    }

    fromWorkspace.animateWorkspaceTransition({
      fromOffsetY: 0,
      toOffsetY: -direction * distance,
      fromOpacity: 1,
      toOpacity: 0,
      visibleAfter: false,
    });
    toWorkspace.prepareWorkspaceTransition(direction * distance, 0);
    toWorkspace.applyLayout();
    toWorkspace.animateWorkspaceTransition({
      fromOffsetY: direction * distance,
      toOffsetY: 0,
      fromOpacity: 0,
      toOpacity: 1,
      visibleAfter: true,
    });
    // Callers that explicitly want to focus a *different* window after the
    // transition (e.g. dock activation) opt out of the implicit focus so the
    // resulting onFocus callback chain does not stomp on their pan.
    if (options.focusActiveAfter !== false) {
      toWorkspace.focusActiveWindow();
    }
    this.applyWorkspaceStackPolicy(fromWorkspace);
    this.applyWorkspaceStackPolicy(toWorkspace);
    this.workspaceChangeBroadcaster?.();
  }

  public getCurrentWorkspace(): Workspace | undefined {
    this.syncWorkspaces();
    return (
      this.workspaceForMonitor(this.currentMonitor) ??
      this.workspaces.values().next().value
    );
  }

  /** Name (connector) of the monitor under the cursor; updated on pointer move. */
  public getCurrentMonitorName(): string {
    this.syncWorkspaces();
    return this.currentMonitor || COMPOSITOR.output.list.at(0) || "";
  }

  /**
   * Compact per-monitor workspace view for external clients (the bar) over IPC.
   */
  public viewForIpc(): WorkspacesView {
    this.syncWorkspaces();

    const byMonitor = new Map<string, WorkspacesViewWorkspace[]>();
    for (const workspace of this.workspaces.values()) {
      const active =
        this.activeWorkspaceByMonitor.get(workspace.monitor) ===
        workspace.index;
      const list = byMonitor.get(workspace.monitor) ?? [];
      const windows: WorkspacesViewWindow[] = workspace
        .listWindows()
        .map((window) => ({
          id: window.id,
          appId: window.appId(),
          title: window.title(),
          focused: window.isFocused(),
          lastFocusedAt: this.lastFocusedAt.get(window.id) ?? 0,
        }));
      list.push({
        index: workspace.index,
        windowCount: workspace.windowCount(),
        isTiled: workspace.isTiled,
        active,
        windows,
      });
      byMonitor.set(workspace.monitor, list);
    }

    const monitors: WorkspacesViewMonitor[] = COMPOSITOR.output.list.map(
      (name) => {
        const active = this.activeWorkspaceByMonitor.get(name) ?? 1;
        // Only surface workspaces that have windows, plus the active one
        // (which stays visible even while empty). Bare, empty, non-active
        // workspaces are hidden from the list.
        const workspaces = (byMonitor.get(name) ?? []).filter(
          (workspace) => workspace.windowCount > 0 || workspace.active,
        );
        if (!workspaces.some((workspace) => workspace.index === active)) {
          workspaces.push({
            index: active,
            windowCount: 0,
            isTiled: false,
            active: true,
            windows: [],
          });
        }
        workspaces.sort((a, b) => a.index - b.index);
        return { name, active, workspaces };
      },
    );

    return { currentMonitor: this.currentMonitor, monitors };
  }

  /**
   * Update MRU stamp for `windowId`. The dock uses this to pick the "most
   * recently used" window per app for left-click focus.
   */
  public recordFocus(windowId: string) {
    this.lastFocusedAt.set(windowId, Date.now());
  }

  private trackPendingInitialFocus(window: WaylandWindow) {
    const token = Date.now();
    this.pendingInitialFocusByWindowId.set(window.id, token);
    setTimeout(() => {
      if (this.pendingInitialFocusByWindowId.get(window.id) === token) {
        this.pendingInitialFocusByWindowId.delete(window.id);
      }
    }, WINDOW_MANAGEMENT_ANIMATION_DURATION);
  }

  private shouldDeferFocusLayoutForInitialOpen(
    window: WaylandWindow,
    workspace: Workspace | undefined,
  ): boolean {
    if (!workspace?.isTiled || !workspace.isActive()) {
      return false;
    }
    if (this.pendingInitialFocusByWindowId.delete(window.id)) {
      return false;
    }
    for (const pendingWindowId of this.pendingInitialFocusByWindowId.keys()) {
      if (
        workspace.isActiveWindowId(pendingWindowId) &&
        workspace.findWindowById(pendingWindowId)
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Find a managed window by id by scanning every workspace. Used by the
   * `windows.activate` IPC handler to bridge bar clicks to focus + workspace
   * switch.
   */
  public findWindowById(windowId: string): WaylandWindow | undefined {
    for (const workspace of this.workspaces.values()) {
      const found = workspace.findWindowById(windowId);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  /** Every managed window across all workspaces (debug/IPC use). */
  public listWindows(): WaylandWindow[] {
    const windows: WaylandWindow[] = [];
    for (const workspace of this.workspaces.values()) {
      windows.push(...workspace.listWindows());
    }
    return windows;
  }

  /**
   * Activate window by id (dock-style "go to this window"). Plays a unified
   * sequence: unminimize → switch workspace (if different) → pan within the
   * workspace so the target is centered → focus. Doing the pan synchronously
   * here (instead of relying on the onFocus → focusWindow callback) gives the
   * same in-sync animation as `Super+Ctrl+Left/Right` and guarantees a visible
   * pan even when the target is already in the viewport.
   *
   * Returns true if the window existed.
   */
  public activateWindowById(windowId: string): boolean {
    const window = this.findWindowById(windowId);
    if (!window) {
      return false;
    }
    const workspace = this.findWorkspaceForWindow(window);
    if (!workspace) {
      return false;
    }

    if (window.state[WINDOW_STATE_MINIMIZED]()) {
      this.onWindowMinimizeRequest({
        window,
        minimized: false,
        source: "api",
        timestamp: Date.now(),
      });
    }

    // Cross-workspace: switch first with the existing slide/fade. Skip the
    // implicit focusActiveWindow — we explicitly focus the target below, and
    // letting switchWorkspaceTo focus the previous active would queue an
    // onFocus → focusWindow → applyLayout cycle that overrides our pan.
    this.switchWorkspaceTo(workspace.monitor, workspace.index, {
      focusActiveAfter: false,
    });

    // Always pan to the target inside the workspace (force-center even if it
    // is already on-screen). This is the "go to this window" gesture.
    if (workspace.isTiled) {
      workspace.panToWindow(window);
    }

    // Focus last so it overrides switchWorkspaceTo's focusActiveWindow().
    window.focus();
    return true;
  }

  /**
   * Activate a specific workspace on a monitor (external/IPC entry point).
   * Plays the same slide/fade transition as keyboard switching.
   */
  public activate(monitor: string, index: number) {
    if (!monitor || index < 1) {
      return;
    }
    this.switchWorkspaceTo(monitor, index);
  }

  public getWindowZIndex(window: WaylandWindow): ReadonlySignal<number> {
    return this.windowStack.zIndex(window);
  }

  private beginInteractiveUnmaximize(window: WaylandWindow): boolean {
    if (!window.state[WINDOW_STATE_MAXIMIZED]()) {
      return false;
    }

    window.state[WINDOW_STATE_MAXIMIZED].set(false);
    window.state[WINDOW_STATE_RESTORE_RECT].set(null);
    this.clearWindowSnapState(window);
    window.unmaximize();
    return true;
  }

  private applyWorkspaceStackPolicy(workspace: Workspace | undefined) {
    if (!workspace) {
      return;
    }

    if (!workspace.isTiled) {
      // Leaving tiling mode removes the "floating windows stay above tiles"
      // policy. Restore normal focus-based stacking explicitly because
      // focusing an already-focused window does not emit another focus event.
      const focusedWindow = workspace.focusedWindow();
      if (focusedWindow && this.windowStack.has(focusedWindow)) {
        this.windowStack.raise(focusedWindow);
      }
      return;
    }

    const floating = workspace
      .floatingWindows()
      .filter((window) => this.windowStack.has(window))
      .sort(
        (a, b) =>
          this.windowStack.zIndexValue(a) - this.windowStack.zIndexValue(b),
      );

    for (const window of floating) {
      this.windowStack.raise(window);
    }
  }

  private syncWorkspaces() {
    for (const monitor of COMPOSITOR.output.list) {
      if (!this.activeWorkspaceByMonitor.has(monitor)) {
        this.activeWorkspaceByMonitor.set(monitor, 1);
      }
      this.ensureWorkspace(
        monitor,
        this.activeWorkspaceByMonitor.get(monitor) ?? 1,
      );
    }

    if (
      !this.currentMonitor ||
      !COMPOSITOR.output.list.includes(this.currentMonitor)
    ) {
      this.currentMonitor = COMPOSITOR.output.list.at(0) ?? "";
    }
  }

  private workspaceForMonitor(monitor: string): Workspace | undefined {
    if (!monitor) {
      return undefined;
    }
    return this.ensureWorkspace(
      monitor,
      this.activeWorkspaceByMonitor.get(monitor) ?? 1,
    );
  }

  private ensureWorkspace(monitor: string, index: number): Workspace {
    const key = workspaceKey(monitor, index);
    let workspace = this.workspaces.get(key);
    if (!workspace) {
      workspace = new Workspace(
        index,
        monitor,
        this.naturalRootRect,
        (window) => this.maximizedRectForWindow(window, monitor),
        (monitor) => this.getActiveWorkspaceIndex(monitor),
        (monitor) => this.resolveMaxColumns(monitor),
      );
      this.workspaces.set(key, workspace);
    }
    return workspace;
  }

  private getActiveWorkspaceIndex(monitor: string): number {
    return this.activeWorkspaceByMonitor.get(monitor) ?? 1;
  }

  private focusWindowAtPointerTarget(
    target: PointerMoveEvent["target"],
    monitorHint?: string,
  ) {
    if (target.kind !== "window") {
      return;
    }

    const workspace = Array.from(this.workspaces.values()).find((workspace) =>
      workspace.findWindowById(target.windowId),
    );
    const window = workspace?.findWindowById(target.windowId);
    if (!workspace || !window) {
      return;
    }

    if (!workspace.isTiled || !workspace.isActive()) {
      return;
    }

    const focused = workspace.focusWindowUnderPointer(window);
    if (!focused) {
      return;
    }

    this.currentMonitor =
      monitorHint && COMPOSITOR.output.list.includes(monitorHint)
        ? monitorHint
        : workspace.monitor;
  }

  private focusWindowAtPointerPosition(
    position: PointerMoveEvent["position"] | null | undefined,
    monitorHint?: string,
  ) {
    if (!position || this.lastPointerTarget.kind === "layer") {
      return;
    }

    const monitor =
      monitorHint && COMPOSITOR.output.list.includes(monitorHint)
        ? monitorHint
        : (this.outputNameAt(position.x, position.y) ?? this.currentMonitor);
    const workspace = this.workspaceForMonitor(monitor);
    if (!workspace?.isTiled || !workspace.isActive()) {
      return;
    }

    const window = workspace
      .listWindows()
      .filter(
        (window) =>
          !window.state[WINDOW_STATE_MINIMIZED]() &&
          this.windowStack.has(window) &&
          managedRectContainsPoint(
            window.state[WINDOW_STATE_RECT](),
            position.x,
            position.y -
              window.state[WINDOW_STATE_WORKSPACE_OFFSET_Y](),
          ),
      )
      .sort(
        (a, b) =>
          this.windowStack.zIndexValue(b) - this.windowStack.zIndexValue(a),
      )[0];
    if (!window || !workspace.focusWindowUnderPointer(window)) {
      return;
    }
    this.currentMonitor = monitor;
  }

  private availableWorkspaceIndex(monitor: string, preferredIndex: number) {
    if (!this.workspaces.has(workspaceKey(monitor, preferredIndex))) {
      return preferredIndex;
    }
    let index = 1;
    while (this.workspaces.has(workspaceKey(monitor, index))) {
      index += 1;
    }
    return index;
  }

  private syncWorkspaceVisibility() {
    for (const workspace of this.workspaces.values()) {
      workspace.setVisible(workspace.isActive());
    }
  }

  private findWorkspaceForWindow(window: WaylandWindow): Workspace | undefined {
    for (const workspace of this.workspaces.values()) {
      if (workspace.hasWindow(window)) {
        return workspace;
      }
    }
    return undefined;
  }

  private findWorkspaceRestoringWindow(
    window: WaylandWindow,
  ): Workspace | undefined {
    for (const workspace of this.workspaces.values()) {
      if (workspace.isRestoringWindow(window.id)) {
        return workspace;
      }
    }
    return undefined;
  }

  private workspaceForTileDrag(
    event: WindowMoveEvent,
    drag: NonNullable<WindowManager["tileDrag"]>,
  ): Workspace {
    const monitor =
      event.outputName && COMPOSITOR.output.list.includes(event.outputName)
        ? event.outputName
        : drag.workspace.monitor;
    let index = this.activeWorkspaceByMonitor.get(monitor) ?? 1;
    const edgeDirection = this.tileDragWorkspaceEdgeDirection(
      monitor,
      event.currentPointer.y,
    );

    if (
      event.modifiers.shift &&
      edgeDirection !== 0 &&
      event.timestamp - drag.lastWorkspaceSwitchAt >=
        TILE_DRAG_WORKSPACE_SWITCH_INTERVAL_MS
    ) {
      const nextIndex = Math.max(1, index + edgeDirection);
      if (nextIndex !== index) {
        this.currentMonitor = monitor;
        this.switchWorkspace(edgeDirection);
        drag.lastWorkspaceSwitchAt = event.timestamp;
        index = this.activeWorkspaceByMonitor.get(monitor) ?? nextIndex;
      }
    }

    return this.ensureWorkspace(monitor, index);
  }

  private workspaceForFloatingDrag(
    event: WindowMoveEvent,
    drag: NonNullable<WindowManager["floatingDrag"]>,
  ): Workspace {
    const monitor =
      event.outputName && COMPOSITOR.output.list.includes(event.outputName)
        ? event.outputName
        : drag.workspace.monitor;
    let index = this.activeWorkspaceByMonitor.get(monitor) ?? 1;
    const edgeDirection = this.tileDragWorkspaceEdgeDirection(
      monitor,
      event.currentPointer.y,
    );

    if (
      event.modifiers.shift &&
      edgeDirection !== 0 &&
      event.timestamp - drag.lastWorkspaceSwitchAt >=
        TILE_DRAG_WORKSPACE_SWITCH_INTERVAL_MS
    ) {
      const nextIndex = Math.max(1, index + edgeDirection);
      if (nextIndex !== index) {
        this.currentMonitor = monitor;
        this.switchWorkspace(edgeDirection);
        drag.lastWorkspaceSwitchAt = event.timestamp;
        index = this.activeWorkspaceByMonitor.get(monitor) ?? nextIndex;
      }
    }

    return this.ensureWorkspace(monitor, index);
  }

  private tileDragWorkspaceEdgeDirection(
    monitor: string,
    y: number,
  ): -1 | 0 | 1 {
    const rect = this.workspaceViewportRect(monitor);
    const top = read(rect.y);
    const height = read(rect.height);
    if (y < top + TILE_DRAG_WORKSPACE_EDGE_PX) {
      return -1;
    }
    if (y > top + height - TILE_DRAG_WORKSPACE_EDGE_PX) {
      return 1;
    }
    return 0;
  }

  private workspaceTransitionDistance(monitor: string): number {
    return read(this.workspaceViewportRect(monitor).height);
  }

  private workspaceViewportRect(monitor: string): ManagedWindowRect {
    const usable = COMPOSITOR.layer.usableArea(monitor);
    if (usable) {
      return usable;
    }

    const output = COMPOSITOR.output.current[monitor];
    if (output?.resolution) {
      return {
        x: output.position.x,
        y: output.position.y,
        width: output.resolution.width / output.scale,
        height: output.resolution.height / output.scale,
      };
    }

    return {
      x: 0,
      y: 0,
      width: 1280,
      height: 720,
    };
  }

  private constrainResizeRect(event: WindowResizeEvent): ManagedWindowRect {
    const constraints = event.window.sizeConstraints();
    const extra = this.clientToRootSizeExtra(event.window);
    const minWidth = Math.max(1, constraints.min?.width ?? 1) + extra.width;
    const minHeight = Math.max(1, constraints.min?.height ?? 1) + extra.height;
    const maxWidth = constrainedMax(constraints, "width", extra.width);
    const maxHeight = constrainedMax(constraints, "height", extra.height);

    const width = clamp(
      event.currentRect.width,
      minWidth,
      Math.max(minWidth, maxWidth),
    );
    const height = clamp(
      event.currentRect.height,
      minHeight,
      Math.max(minHeight, maxHeight),
    );

    return {
      x: resizeOriginForAxis(
        event.startRect,
        event.currentRect,
        width,
        event.edges.left,
        "x",
      ),
      y: resizeOriginForAxis(
        event.startRect,
        event.currentRect,
        height,
        event.edges.top,
        "y",
      ),
      width,
      height,
    };
  }

  private clientToRootSizeExtra(window: WaylandWindow): {
    width: number;
    height: number;
  } {
    const natural = this.naturalRootRect(window);
    return {
      width: Math.max(0, read(natural.width) - window.position.width),
      height: Math.max(0, read(natural.height) - window.position.height),
    };
  }

  private maximizedRectForWindow(
    window: WaylandWindow,
    preferredOutput?: string,
  ): ManagedWindowRect {
    const rect = window.state[WINDOW_STATE_RECT]();
    const centerX = read(rect.x) + read(rect.width) / 2;
    const centerY = read(rect.y) + read(rect.height) / 2;
    const outputName =
      preferredOutput ??
      this.outputNameAt(centerX, centerY) ??
      this.currentMonitor;
    const output = outputName
      ? COMPOSITOR.output.current[outputName]
      : undefined;
    const usable = outputName
      ? COMPOSITOR.layer.usableArea(outputName)
      : undefined;

    if (usable) {
      return insetRect(
        {
          x: usable.x,
          y: usable.y,
          width: usable.width,
          height: usable.height,
        },
        MAXIMIZED_WINDOW_PADDING,
      );
    }
    if (output?.resolution) {
      return insetRect(
        {
          x: output.position.x,
          y: output.position.y,
          width: output.resolution.width / output.scale,
          height: output.resolution.height / output.scale,
        },
        MAXIMIZED_WINDOW_PADDING,
      );
    }
    return rect;
  }

  // Fullscreen covers the entire output: unlike maximize it ignores the
  // usable area (exclusive-zone bars) and applies no padding, so the client
  // surface spans edge to edge. This is also what lets the tty backend
  // collapse the frame to a single scanout-capable element.
  private fullscreenRectForWindow(
    window: WaylandWindow,
    preferredOutput?: string,
  ): ManagedWindowRect {
    const rect = window.state[WINDOW_STATE_RECT]();
    const centerX = read(rect.x) + read(rect.width) / 2;
    const centerY = read(rect.y) + read(rect.height) / 2;
    const outputName =
      preferredOutput ??
      this.outputNameAt(centerX, centerY) ??
      this.currentMonitor;
    const output = outputName
      ? COMPOSITOR.output.current[outputName]
      : undefined;
    if (output?.resolution) {
      return {
        x: output.position.x,
        y: output.position.y,
        width: output.resolution.width / output.scale,
        height: output.resolution.height / output.scale,
      };
    }
    return rect;
  }

  public onWindowFullscreenRequest(event: WindowFullscreenRequestEvent) {
    if (this.isGrabbing) {
      return;
    }
    const window = event.window;
    const workspace = this.findWorkspaceForWindow(window);
    window.state[WINDOW_STATE_MINIMIZED].set(false);
    this.clearWindowSnapState(window);

    if (!event.fullscreen) {
      const restoreRect = window.state[WINDOW_STATE_FULLSCREEN_RESTORE_RECT]();
      window.state[WINDOW_STATE_FULLSCREEN].set(false);
      window.state[WINDOW_STATE_FULLSCREEN_RESTORE_RECT].set(null);
      // A tiled window returns to its computed slot; a floating one animates
      // back to where it was before going fullscreen.
      if (workspace?.isTiled && workspace.shouldTile(window)) {
        workspace.applyLayout();
        this.applyWorkspaceStackPolicy(workspace);
        return;
      }
      if (restoreRect) {
        workspace?.syncFloatingWindowRect(window, restoreRect);
        playRectAnimation(
          window,
          WINDOW_STATE_RECT,
          restoreRect,
          WINDOW_MANAGEMENT_EASING,
          WINDOW_MANAGEMENT_ANIMATION_DURATION,
        );
      }
      this.applyWorkspaceStackPolicy(workspace);
      return;
    }

    if (!window.state[WINDOW_STATE_FULLSCREEN]()) {
      const currentRect = window.state[WINDOW_STATE_RECT]();
      const currentWidth = read(currentRect.width);
      const currentHeight = read(currentRect.height);
      if (currentWidth > 1 && currentHeight > 1) {
        window.state[WINDOW_STATE_FULLSCREEN_RESTORE_RECT].set(currentRect);
      }
    }
    const fullscreenRect = this.fullscreenRectForWindow(
      window,
      event.outputName,
    );
    window.state[WINDOW_STATE_FULLSCREEN].set(true);
    workspace?.focusWindow(window);
    workspace?.syncFloatingWindowRect(window, fullscreenRect);
    playRectAnimation(
      window,
      WINDOW_STATE_RECT,
      fullscreenRect,
      WINDOW_MANAGEMENT_EASING,
      WINDOW_MANAGEMENT_ANIMATION_DURATION,
    );
    this.applyWorkspaceStackPolicy(workspace);
    window.focus();
  }

  private initialRestoreRectForMaximizedWindow(
    window: WaylandWindow,
  ): ManagedWindowRect {
    const maximizedRect = this.maximizedRectForWindow(window);
    const width = Math.max(1, read(maximizedRect.width) * 0.7);
    const height = Math.max(1, read(maximizedRect.height) * 0.7);
    return {
      x: read(maximizedRect.x) + (read(maximizedRect.width) - width) / 2,
      y: read(maximizedRect.y) + (read(maximizedRect.height) - height) / 2,
      width,
      height,
    };
  }

  private restoreRectForMaximizedMove(
    event: WindowMoveEvent,
    width: number,
    height: number,
  ): ManagedWindowRect {
    const pointer = event.currentPointer;
    const titlebarCenterY = WINDOW_BORDER_PX + TITLEBAR_HEIGHT / 2;
    const pointerOffsetY =
      event.source === "modifier"
        ? height / 2
        : Math.min(height / 2, titlebarCenterY);

    return {
      x: pointer.x - width / 2,
      y: pointer.y - pointerOffsetY,
      width,
      height,
    };
  }

  private outputNameAt(x: number, y: number): string | undefined {
    for (const name of COMPOSITOR.output.list) {
      const output = COMPOSITOR.output.current[name];
      if (!output?.resolution) {
        continue;
      }
      const width = output.resolution.width / output.scale;
      const height = output.resolution.height / output.scale;
      if (
        x >= output.position.x &&
        y >= output.position.y &&
        x < output.position.x + width &&
        y < output.position.y + height
      ) {
        return name;
      }
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Snap zones (Windows-style edge snapping for floating drags + tiling drag
  // slot preview). The bar renders the preview rect; this side decides the
  // zone, broadcasts the preview, and applies the snap on drop.
  // -------------------------------------------------------------------------

  public setSnapPreviewBroadcaster(broadcaster: SnapPreviewBroadcaster | null) {
    this.snapPreviewBroadcaster = broadcaster;
  }

  public setWorkspaceChangeBroadcaster(
    broadcaster: WorkspaceChangeBroadcaster | null,
  ) {
    this.workspaceChangeBroadcaster = broadcaster;
  }

  /** Full logical rect of a monitor (ignores reserved insets). */
  private monitorFullRect(monitor: string): ManagedWindowRect | null {
    const output = COMPOSITOR.output.current[monitor];
    if (!output?.resolution) {
      return null;
    }
    return {
      x: output.position.x,
      y: output.position.y,
      width: output.resolution.width / output.scale,
      height: output.resolution.height / output.scale,
    };
  }

  /** Usable area inset by the maximized padding — the base for all snap rects. */
  private monitorSnapBaseRect(monitor: string): ManagedWindowRect | null {
    const usable =
      COMPOSITOR.layer.usableArea(monitor) ??
      this.monitorFullRect(monitor);
    if (!usable) {
      return null;
    }
    return insetRect(usable, MAXIMIZED_WINDOW_PADDING);
  }

  /** Resolve the snap zone for a pointer near the physical screen edges. */
  private floatingSnapZoneAt(
    monitor: string,
    px: number,
    py: number,
  ): SnapZone | null {
    const full = this.monitorFullRect(monitor);
    if (!full) {
      return null;
    }
    const left = read(full.x);
    const top = read(full.y);
    const right = left + read(full.width);
    const bottom = top + read(full.height);

    const nearLeft = px <= left + SNAP_EDGE_PX;
    const nearRight = px >= right - SNAP_EDGE_PX;
    const nearTop = py <= top + SNAP_EDGE_PX;

    // Corners win over edges so the quarters stay reachable.
    if (nearLeft && py <= top + SNAP_CORNER_PX) return "top-left";
    if (nearLeft && py >= bottom - SNAP_CORNER_PX) return "bottom-left";
    if (nearRight && py <= top + SNAP_CORNER_PX) return "top-right";
    if (nearRight && py >= bottom - SNAP_CORNER_PX) return "bottom-right";
    if (nearTop) return "maximize";
    if (nearLeft) return "left";
    if (nearRight) return "right";
    return null;
  }

  /** Target rect (global logical coords) for a snap zone on a monitor. */
  private snapZoneRect(
    monitor: string,
    zone: SnapZone,
  ): ManagedWindowRect | null {
    const base = this.monitorSnapBaseRect(monitor);
    if (!base) {
      return null;
    }
    const bx = read(base.x);
    const by = read(base.y);
    const bw = read(base.width);
    const bh = read(base.height);
    const halfW = (bw - SNAP_GAP_PX) / 2;
    const halfH = (bh - SNAP_GAP_PX) / 2;
    const rightX = bx + halfW + SNAP_GAP_PX;
    const bottomY = by + halfH + SNAP_GAP_PX;

    switch (zone) {
      case "maximize":
        return { x: bx, y: by, width: bw, height: bh };
      case "left":
        return { x: bx, y: by, width: halfW, height: bh };
      case "right":
        return { x: rightX, y: by, width: halfW, height: bh };
      case "top-left":
        return { x: bx, y: by, width: halfW, height: halfH };
      case "top-right":
        return { x: rightX, y: by, width: halfW, height: halfH };
      case "bottom-left":
        return { x: bx, y: bottomY, width: halfW, height: halfH };
      case "bottom-right":
        return { x: rightX, y: bottomY, width: halfW, height: halfH };
    }
  }

  private resizeFloatingSnapLayout(
    event: WindowResizeEvent,
    workspace: Workspace,
    nextRect: ManagedWindowRect,
  ): boolean {
    if (workspace.isTiled) {
      return false;
    }

    const zone = event.window.state[WINDOW_STATE_SNAP_ZONE]();
    if (!isLayoutSnapZone(zone)) {
      return false;
    }

    const monitor =
      event.window.state[WINDOW_STATE_SNAP_MONITOR]() || workspace.monitor;
    const base = this.monitorSnapBaseRect(monitor);
    if (!base) {
      return false;
    }

    const snappedWindows = workspace
      .listWindows()
      .filter((window) => this.isWindowInFloatingSnapLayout(window, monitor));
    if (!snappedWindows.some((window) => window.id === event.window.id)) {
      return false;
    }

    const layout = this.floatingSnapLayoutFromWindows(base, snappedWindows);
    let changed = false;

    if (event.edges.right && isLeftSnapZone(zone)) {
      layout.splitX = read(nextRect.x) + read(nextRect.width);
      changed = true;
    } else if (event.edges.left && isRightSnapZone(zone)) {
      layout.splitX = read(nextRect.x) - SNAP_GAP_PX;
      changed = true;
    }

    if (event.edges.bottom && isTopSnapZone(zone)) {
      if (snapColumn(zone) === "left") {
        layout.leftSplitY = read(nextRect.y) + read(nextRect.height);
      } else {
        layout.rightSplitY = read(nextRect.y) + read(nextRect.height);
      }
      changed = true;
    } else if (event.edges.top && isBottomSnapZone(zone)) {
      if (snapColumn(zone) === "left") {
        layout.leftSplitY = read(nextRect.y) - SNAP_GAP_PX;
      } else {
        layout.rightSplitY = read(nextRect.y) - SNAP_GAP_PX;
      }
      changed = true;
    }

    if (!changed) {
      return false;
    }

    this.clampFloatingSnapLayout(base, layout, snappedWindows);
    this.applyFloatingSnapLayout(base, layout, snappedWindows);
    return true;
  }

  private isWindowInFloatingSnapLayout(
    window: WaylandWindow,
    monitor: string,
  ): boolean {
    return (
      isLayoutSnapZone(window.state[WINDOW_STATE_SNAP_ZONE]()) &&
      window.state[WINDOW_STATE_SNAP_MONITOR]() === monitor &&
      !window.state[WINDOW_STATE_MINIMIZED]() &&
      !window.state[WINDOW_STATE_MAXIMIZED]()
    );
  }

  private floatingSnapLayoutFromWindows(
    base: ManagedWindowRect,
    windows: WaylandWindow[],
  ): FloatingSnapLayout {
    const bx = read(base.x);
    const by = read(base.y);
    const bw = read(base.width);
    const bh = read(base.height);
    const defaultSplitX = bx + (bw - SNAP_GAP_PX) / 2;
    const defaultSplitY = by + (bh - SNAP_GAP_PX) / 2;
    const splitXSamples: number[] = [];
    const leftSplitYSamples: number[] = [];
    const rightSplitYSamples: number[] = [];

    for (const window of windows) {
      const zone = window.state[WINDOW_STATE_SNAP_ZONE]();
      if (!isLayoutSnapZone(zone)) {
        continue;
      }
      const rect = window.state[WINDOW_STATE_RECT]();
      if (isLeftSnapZone(zone)) {
        splitXSamples.push(read(rect.x) + read(rect.width));
      } else {
        splitXSamples.push(read(rect.x) - SNAP_GAP_PX);
      }

      if (isTopSnapZone(zone)) {
        const samples =
          snapColumn(zone) === "left" ? leftSplitYSamples : rightSplitYSamples;
        samples.push(read(rect.y) + read(rect.height));
      } else if (isBottomSnapZone(zone)) {
        const samples =
          snapColumn(zone) === "left" ? leftSplitYSamples : rightSplitYSamples;
        samples.push(read(rect.y) - SNAP_GAP_PX);
      }
    }

    return {
      splitX: averageOr(splitXSamples, defaultSplitX),
      leftSplitY: averageOr(leftSplitYSamples, defaultSplitY),
      rightSplitY: averageOr(rightSplitYSamples, defaultSplitY),
    };
  }

  private clampFloatingSnapLayout(
    base: ManagedWindowRect,
    layout: FloatingSnapLayout,
    windows: WaylandWindow[],
  ): void {
    const bx = read(base.x);
    const by = read(base.y);
    const bw = read(base.width);
    const bh = read(base.height);
    const groups = this.floatingSnapMinSizeGroups(windows);

    layout.splitX = clamp(
      layout.splitX,
      bx + groups.leftWidth,
      bx + bw - SNAP_GAP_PX - groups.rightWidth,
    );
    layout.leftSplitY = clamp(
      layout.leftSplitY,
      by + groups.leftTopHeight,
      by + bh - SNAP_GAP_PX - groups.leftBottomHeight,
    );
    layout.rightSplitY = clamp(
      layout.rightSplitY,
      by + groups.rightTopHeight,
      by + bh - SNAP_GAP_PX - groups.rightBottomHeight,
    );
  }

  private floatingSnapMinSizeGroups(windows: WaylandWindow[]): {
    leftWidth: number;
    rightWidth: number;
    leftTopHeight: number;
    leftBottomHeight: number;
    rightTopHeight: number;
    rightBottomHeight: number;
  } {
    const groups = {
      leftWidth: 1,
      rightWidth: 1,
      leftTopHeight: 1,
      leftBottomHeight: 1,
      rightTopHeight: 1,
      rightBottomHeight: 1,
    };

    for (const window of windows) {
      const zone = window.state[WINDOW_STATE_SNAP_ZONE]();
      if (!isLayoutSnapZone(zone)) {
        continue;
      }

      const minSize = this.floatingSnapMinSize(window);
      if (isLeftSnapZone(zone)) {
        groups.leftWidth = Math.max(groups.leftWidth, minSize.width);
      } else {
        groups.rightWidth = Math.max(groups.rightWidth, minSize.width);
      }

      if (isTopSnapZone(zone)) {
        if (snapColumn(zone) === "left") {
          groups.leftTopHeight = Math.max(groups.leftTopHeight, minSize.height);
        } else {
          groups.rightTopHeight = Math.max(
            groups.rightTopHeight,
            minSize.height,
          );
        }
      } else if (isBottomSnapZone(zone)) {
        if (snapColumn(zone) === "left") {
          groups.leftBottomHeight = Math.max(
            groups.leftBottomHeight,
            minSize.height,
          );
        } else {
          groups.rightBottomHeight = Math.max(
            groups.rightBottomHeight,
            minSize.height,
          );
        }
      }
    }

    return groups;
  }

  private floatingSnapMinSize(window: WaylandWindow): {
    width: number;
    height: number;
  } {
    const constraints = window.sizeConstraints();
    const extra = this.clientToRootSizeExtra(window);
    return {
      width: Math.max(1, constraints.min?.width ?? 1) + extra.width,
      height: Math.max(1, constraints.min?.height ?? 1) + extra.height,
    };
  }

  private applyFloatingSnapLayout(
    base: ManagedWindowRect,
    layout: FloatingSnapLayout,
    windows: WaylandWindow[],
  ): void {
    for (const window of windows) {
      const zone = window.state[WINDOW_STATE_SNAP_ZONE]();
      if (!isLayoutSnapZone(zone)) {
        continue;
      }

      const rect = this.floatingSnapRectForZone(base, layout, zone);
      stopRectAnimation(window, WINDOW_STATE_RECT);
      window.state[WINDOW_STATE_RECT].set(rect);
    }
  }

  private floatingSnapRectForZone(
    base: ManagedWindowRect,
    layout: FloatingSnapLayout,
    zone: LayoutSnapZone,
  ): ManagedWindowRect {
    const bx = read(base.x);
    const by = read(base.y);
    const bw = read(base.width);
    const bh = read(base.height);
    const rightX = layout.splitX + SNAP_GAP_PX;
    const leftWidth = Math.max(1, layout.splitX - bx);
    const rightWidth = Math.max(1, bx + bw - rightX);

    switch (zone) {
      case "left":
        return { x: bx, y: by, width: leftWidth, height: bh };
      case "right":
        return { x: rightX, y: by, width: rightWidth, height: bh };
      case "top-left":
        return {
          x: bx,
          y: by,
          width: leftWidth,
          height: Math.max(1, layout.leftSplitY - by),
        };
      case "bottom-left": {
        const y = layout.leftSplitY + SNAP_GAP_PX;
        return {
          x: bx,
          y,
          width: leftWidth,
          height: Math.max(1, by + bh - y),
        };
      }
      case "top-right":
        return {
          x: rightX,
          y: by,
          width: rightWidth,
          height: Math.max(1, layout.rightSplitY - by),
        };
      case "bottom-right": {
        const y = layout.rightSplitY + SNAP_GAP_PX;
        return {
          x: rightX,
          y,
          width: rightWidth,
          height: Math.max(1, by + bh - y),
        };
      }
    }
  }

  private setWindowSnapState(
    workspace: Workspace | undefined,
    window: WaylandWindow,
    monitor: string,
    zone: LayoutSnapZone,
  ): void {
    if (workspace) {
      for (const other of workspace.listWindows()) {
        if (other.id === window.id) {
          continue;
        }
        if (
          other.state[WINDOW_STATE_SNAP_MONITOR]() === monitor &&
          snapZonesConflict(other.state[WINDOW_STATE_SNAP_ZONE](), zone)
        ) {
          this.clearWindowSnapState(other);
        }
      }
    }

    window.state[WINDOW_STATE_SNAP_ZONE].set(zone);
    window.state[WINDOW_STATE_SNAP_MONITOR].set(monitor);
  }

  private clearWindowSnapState(window: WaylandWindow): void {
    window.state[WINDOW_STATE_SNAP_ZONE].set(null);
    window.state[WINDOW_STATE_SNAP_MONITOR].set(null);
  }

  /** Broadcast a preview rect (converted to monitor-local) or a hide (null). */
  private emitSnapPreview(
    monitor: string,
    rect: ManagedWindowRect | null,
    kind: "floating" | "tiling",
  ) {
    if (!this.snapPreviewBroadcaster) {
      return;
    }
    if (!rect) {
      this.snapPreviewBroadcaster({ monitor, rect: null, kind });
      return;
    }
    const output = COMPOSITOR.output.current[monitor];
    const ox = output?.position.x ?? 0;
    const oy = output?.position.y ?? 0;
    this.snapPreviewBroadcaster({
      monitor,
      kind,
      rect: {
        x: read(rect.x) - ox,
        y: read(rect.y) - oy,
        width: read(rect.width),
        height: read(rect.height),
      },
    });
  }

  /** Update the floating-drag snap candidate + preview during a move. */
  private updateFloatingDragSnap(event: WindowMoveEvent) {
    if (event.modifiers.shift) {
      this.clearFloatingSnapPreview();
      return;
    }
    if (event.phase === "start") {
      this.clearFloatingSnapPreview();
      return;
    }
    if (event.phase === "end" || event.phase === "cancel") {
      return;
    }

    const monitor =
      event.outputName &&
      COMPOSITOR.output.list.includes(event.outputName)
        ? event.outputName
        : this.currentMonitor;
    const zone = monitor
      ? this.floatingSnapZoneAt(
          monitor,
          event.currentPointer.x,
          event.currentPointer.y,
        )
      : null;

    if (!monitor || !zone) {
      this.clearFloatingSnapPreview();
      return;
    }

    const rect = this.snapZoneRect(monitor, zone);
    if (!rect) {
      this.clearFloatingSnapPreview();
      return;
    }
    if (
      this.floatingSnap &&
      (this.floatingSnap.windowId !== event.window.id ||
        this.floatingSnap.monitor !== monitor)
    ) {
      this.emitSnapPreview(this.floatingSnap.monitor, null, "floating");
    }
    this.floatingSnap = { windowId: event.window.id, monitor, zone, rect };
    this.emitSnapPreview(monitor, rect, "floating");
  }

  private clearFloatingSnapPreview() {
    if (!this.floatingSnap) {
      return;
    }
    this.emitSnapPreview(this.floatingSnap.monitor, null, "floating");
    this.floatingSnap = null;
  }

  /**
   * Apply the pending snap on drop (or clear it on cancel). Returns true if the
   * window was snapped, so the caller skips leaving it at the drop position.
   */
  private finishFloatingDragSnap(
    event: WindowMoveEvent,
    workspace: Workspace | undefined,
  ): boolean {
    if (event.modifiers.shift) {
      this.clearFloatingSnapPreview();
      return false;
    }
    const snap = this.floatingSnap;
    this.floatingSnap = null;
    if (!snap || snap.windowId !== event.window.id) {
      if (snap) {
        this.emitSnapPreview(snap.monitor, null, "floating");
      }
      return false;
    }

    this.emitSnapPreview(snap.monitor, null, "floating");
    if (event.phase !== "end") {
      return false;
    }

    const window = event.window;
    const isMaximized = window.state[WINDOW_STATE_MAXIMIZED]();

    if (snap.zone === "maximize") {
      this.clearWindowSnapState(window);
      // Route through the real maximize so the compositor `isMaximized` state
      // (and therefore the SSD maximize/restore icon) stays in sync. Calling
      // maximize() fires onWindowMaximizeRequest, which applies the rect.
      if (!isMaximized) {
        window.maximize();
      } else {
        // Already maximized (e.g. re-dropped on the top edge): just re-apply
        // the maximized rect for the monitor under the cursor.
        const rect = this.maximizedRectForWindow(window);
        playRectAnimation(
          window,
          WINDOW_STATE_RECT,
          rect,
          WINDOW_MANAGEMENT_EASING,
          WINDOW_MANAGEMENT_ANIMATION_DURATION,
        );
        workspace?.syncFloatingWindowRect(window, rect);
      }
    } else {
      // Half / quarter: ensure the window is unmaximized first (syncs the SSD
      // icon), with the restore rect cleared so unmaximize() does not animate
      // back to it and fight the snap, then place it at the zone rect.
      if (isMaximized) {
        window.state[WINDOW_STATE_RESTORE_RECT].set(null);
        window.state[WINDOW_STATE_MAXIMIZED].set(false);
        window.unmaximize();
      }
      playRectAnimation(
        window,
        WINDOW_STATE_RECT,
        snap.rect,
        WINDOW_MANAGEMENT_EASING,
        WINDOW_MANAGEMENT_ANIMATION_DURATION,
      );
      this.setWindowSnapState(workspace, window, snap.monitor, snap.zone);
      workspace?.syncFloatingWindowRect(window, snap.rect);
    }
    this.applyWorkspaceStackPolicy(workspace);
    return true;
  }
}
