import {
  COMPOSITOR,
  createManagedPoll,
  markManagedWindowDirty,
  read,
  type PollHandle,
  type WaylandWindow,
} from "shoji_wm";
import type { ManagedWindowRect } from "shoji_wm/types";
import { playRectAnimation, stopRectAnimation } from "../window-animation";
import {
  TILE_ANIMATION_DURATION,
  TILE_GAP,
  TILE_MAX_COLUMNS,
  TILE_MIN_WIDTH,
  WINDOW_MANAGEMENT_ANIMATION_DURATION,
  WINDOW_MANAGEMENT_EASING,
  WINDOW_STATE_FLOATING_RECT,
  WINDOW_STATE_FULLSCREEN,
  WINDOW_STATE_MAXIMIZED,
  WINDOW_STATE_MINIMIZED,
  WINDOW_STATE_MINIMIZE_VISUAL_IDLE,
  WINDOW_STATE_RECT,
  WINDOW_STATE_RESTORE_RECT,
  WINDOW_STATE_SNAP_MONITOR,
  WINDOW_STATE_SNAP_ZONE,
  WINDOW_STATE_TILED,
  WINDOW_STATE_TILE_DRAGGING,
  WINDOW_STATE_VISIBLE_OUTPUTS,
  WINDOW_STATE_WORKSPACE_OFFSET_Y,
  WINDOW_STATE_WORKSPACE_OPACITY,
  WINDOW_STATE_WORKSPACE_VISIBLE,
  WORKSPACE_KINETIC_SCROLL_FALLBACK_REFRESH_RATE,
  WORKSPACE_KINETIC_SCROLL_MAX_VELOCITY,
  WORKSPACE_KINETIC_SCROLL_MIN_VELOCITY,
  WORKSPACE_KINETIC_SCROLL_STOP_VELOCITY,
  WORKSPACE_KINETIC_SCROLL_TIME_CONSTANT_MS,
  WORKSPACE_SWITCH_ANIMATION_DURATION,
  type WorkspaceSnapshot,
  type WorkspaceWindowSnapshot,
} from "./state";
import { clamp, insetRect, managedRectEquals, rectCenterX, snapshotManagedRect } from "./geometry";
import { hotReloadDebug } from "./debug";
import { MANAGED_WINDOW_ONLY_ANIMATION, withManagedWindowOnlySSDRebuildSuppressed } from "./ssd";
import {
  cancelWorkspaceVisualAnimation,
  resetWorkspaceVisualState,
  scheduleWorkspaceVisualAnimation,
} from "./lifecycle-animation";

interface LayoutOptions {
  suppressSSDRebuild?: boolean;
  animate?: boolean;
  preserveMissingActive?: boolean;
  cancelRectAnimations?: boolean;
}
export class Workspace {
  public index: number;
  private readonly windows: WaylandWindow[] = [];
  private readonly naturalRootRect: (
    window: WaylandWindow,
  ) => ManagedWindowRect;
  private readonly maximizedRootRect: (
    window: WaylandWindow,
  ) => ManagedWindowRect;
  private readonly activeWorkspaceIndex: (monitor: string) => number;
  private readonly restoredWindowStateById = new Map<
    string,
    WorkspaceWindowSnapshot
  >();
  private activeWindowId: string | null = null;
  private visibilityAnimationToken = 0;
  private draggingWindowId: string | null = null;
  // Layout slot reserved for the tile being dragged (the gap opened in the row).
  // Captured during applyLayout so the bar can preview where the tile will land.
  private lastDraggingSlotRect: ManagedWindowRect | null = null;
  private lastAppliedTileViewportRect: ManagedWindowRect | null = null;
  private scrollOffset = 0;
  private kineticScrollPoll: PollHandle | null = null;
  private kineticScrollToken = 0;
  public monitor: string;
  public isTiled = true;

  public constructor(
    index: number,
    monitor: string,
    naturalRootRect: (window: WaylandWindow) => ManagedWindowRect,
    maximizedRootRect: (window: WaylandWindow) => ManagedWindowRect,
    activeWorkspaceIndex: (monitor: string) => number,
  ) {
    this.index = index;
    this.monitor = monitor;
    this.naturalRootRect = naturalRootRect;
    this.maximizedRootRect = maximizedRootRect;
    this.activeWorkspaceIndex = activeWorkspaceIndex;
  }

  public moveToMonitor(monitor: string, index: number) {
    this.monitor = monitor;
    this.index = index;
    for (const window of this.windows) {
      this.syncWindowVisibleOutputs(window);
      if (window.state[WINDOW_STATE_FULLSCREEN]()) {
        window.state[WINDOW_STATE_RECT].set(this.fullscreenRootRect(window));
        continue;
      }
      if (window.state[WINDOW_STATE_MAXIMIZED]()) {
        window.state[WINDOW_STATE_RECT].set(this.maximizedRootRect(window));
        continue;
      }

      if (!this.isTiled || !this.shouldTile(window)) {
        const rect = this.clampRectToViewport(
          window.state[WINDOW_STATE_RECT](),
        );
        window.state[WINDOW_STATE_RECT].set(rect);
        window.state[WINDOW_STATE_FLOATING_RECT].set(
          this.isTiled ? this.viewportRectToFloatingContentRect(rect) : null,
        );
      }
    }
  }

  public addWindow(window: WaylandWindow): boolean {
    if (this.windows.map((window) => window.id).includes(window.id)) {
      hotReloadDebug("workspace-add-existing-skip", {
        monitor: this.monitor,
        index: this.index,
        windowId: window.id,
        windowIds: this.windows.map((window) => window.id),
      });
      return false;
    }
    this.windows.push(window);
    const restored = this.restoredWindowStateById.get(window.id);
    const isTileableInCurrentMode = !this.isTiled || this.shouldTile(window);
    if (!restored && isTileableInCurrentMode) {
      this.activeWindowId = window.id;
    }
    if (restored) {
      window.cancelAnimation();
      hotReloadDebug("workspace-add-restored-cancel-animation", {
        monitor: this.monitor,
        index: this.index,
        windowId: window.id,
        activeWindowId: this.activeWindowId,
        restoredWindowIds: Array.from(this.restoredWindowStateById.keys()),
        windowIds: this.windows.map((window) => window.id),
      });
      this.restoredWindowStateById.delete(window.id);
      window.state[WINDOW_STATE_FLOATING_RECT].set(
        restored.floatingRect ?? null,
      );
      window.state[WINDOW_STATE_RESTORE_RECT].set(restored.restoreRect ?? null);
      window.state[WINDOW_STATE_SNAP_ZONE].set(restored.snapZone ?? null);
      window.state[WINDOW_STATE_SNAP_MONITOR].set(
        restored.snapMonitor ?? null,
      );
      window.state[WINDOW_STATE_MINIMIZED].set(restored.minimized);
      window.state[WINDOW_STATE_MINIMIZE_VISUAL_IDLE].set(restored.minimized);
      window.state[WINDOW_STATE_MAXIMIZED].set(restored.maximized);
    }
    const visible = this.isActive();
    window.state[WINDOW_STATE_WORKSPACE_VISIBLE].set(visible);
    window.state[WINDOW_STATE_WORKSPACE_OFFSET_Y].set(0);
    window.state[WINDOW_STATE_WORKSPACE_OPACITY].set(visible ? 1 : 0);
    this.syncWindowVisibleOutputs(window);

    if (!COMPOSITOR.output.list.includes(this.monitor)) {
      return restored !== undefined;
    }

    if (restored?.floatingRect && !this.isTiled) {
      window.state[WINDOW_STATE_RECT].set(restored.floatingRect);
    } else if (this.isTiled && this.shouldTile(window)) {
      const initialRect = this.centeredFloatingRect(window);
      window.state[WINDOW_STATE_FLOATING_RECT].set(
        restored?.floatingRect ?? initialRect,
      );
      this.scrollToWindow(window);
      this.applyLayout({
        suppressSSDRebuild: false,
        animate: restored === undefined,
        preserveMissingActive: restored !== undefined,
      });
    } else if (this.isTiled) {
      const initialRect = this.centeredFloatingRect(window);
      const contentRect =
        restored?.floatingRect ??
        this.viewportRectToFloatingContentRect(initialRect);
      window.state[WINDOW_STATE_FLOATING_RECT].set(contentRect);
      window.state[WINDOW_STATE_RECT].set(
        this.floatingContentRectToViewportRect(contentRect),
      );
    } else {
      window.state[WINDOW_STATE_RECT].set(this.centeredFloatingRect(window));
    }
    hotReloadDebug("workspace-add-window", {
      monitor: this.monitor,
      index: this.index,
      windowId: window.id,
      restored: restored !== undefined,
      isTiledWorkspace: this.isTiled,
      shouldTile: this.shouldTile(window),
      activeWindowId: this.activeWindowId,
      windowIds: this.windows.map((window) => window.id),
      rect: window.state[WINDOW_STATE_RECT](),
      floatingRect: window.state[WINDOW_STATE_FLOATING_RECT](),
    });
    return restored !== undefined;
  }

  public removeWindow(window: WaylandWindow): WaylandWindow | null | undefined {
    const index = this.windows.findIndex((current) => current.id === window.id);
    if (index >= 0) {
      this.windows.splice(index, 1);
      if (this.draggingWindowId === window.id) {
        this.draggingWindowId = null;
        window.state[WINDOW_STATE_TILE_DRAGGING].set(false);
      }
      let nextFocus: WaylandWindow | null = null;
      if (this.activeWindowId === window.id) {
        nextFocus =
          this.tileableWindows()[
            Math.min(index, this.tileableWindows().length - 1)
          ] ?? null;
        this.activeWindowId = nextFocus?.id ?? null;
      }
      return nextFocus;
    }
    return undefined;
  }

  public removeTileDragWindow(window: WaylandWindow) {
    const index = this.windows.findIndex((current) => current.id === window.id);
    if (index < 0) {
      return;
    }
    this.windows.splice(index, 1);
    this.draggingWindowId = null;
  }

  public removeFloatingWindow(window: WaylandWindow) {
    const index = this.windows.findIndex((current) => current.id === window.id);
    if (index < 0) {
      return;
    }
    this.windows.splice(index, 1);
    if (this.activeWindowId === window.id) {
      this.activeWindowId =
        this.activeWindow(this.tileableWindows())?.id ?? null;
    }
  }

  public hasWindow(window: WaylandWindow): boolean {
    return this.windows.some((current) => current.id === window.id);
  }

  public windowCount(): number {
    return this.windows.length;
  }

  /**
   * Snapshot of every window currently in this workspace. The returned array
   * is a copy; mutating it is safe and won't affect the workspace state.
   */
  public listWindows(): WaylandWindow[] {
    return this.windows.slice();
  }

  public findWindowById(windowId: string): WaylandWindow | undefined {
    return this.windows.find((window) => window.id === windowId);
  }

  public isActiveWindowId(windowId: string): boolean {
    return this.activeWindowId === windowId;
  }

  public moveFocusedTile(direction: -1 | 1): boolean {
    if (!this.isTiled) {
      return false;
    }

    const focused = this.focusedWindow();
    if (!focused || !this.shouldTile(focused)) {
      return false;
    }

    const tileable = this.tileableWindows();
    const currentIndex = tileable.findIndex(
      (window) => window.id === focused.id,
    );
    if (currentIndex < 0) {
      return false;
    }

    const nextIndex = currentIndex + direction;
    if (nextIndex < 0 || nextIndex >= tileable.length) {
      return false;
    }

    this.stopKineticScroll();
    this.activeWindowId = focused.id;
    this.moveTileWindowToIndex(focused, nextIndex);
    this.scrollToWindow(focused);
    this.applyLayout();
    focused.focus();
    return true;
  }

  public takeWindowForMove(
    window: WaylandWindow,
  ): { window: WaylandWindow; snapshot: WorkspaceWindowSnapshot } | null {
    if (!this.hasWindow(window)) {
      return null;
    }

    const snapshot = this.snapshotWindow(window);
    this.removeWindow(window);
    return { window, snapshot };
  }

  public allWindows(): readonly WaylandWindow[] {
    return this.windows;
  }

  public addMovedWindow(
    window: WaylandWindow,
    snapshot: WorkspaceWindowSnapshot,
  ): boolean {
    this.restoredWindowStateById.set(window.id, snapshot);
    return this.addWindow(window);
  }

  public isRestoringWindow(windowId: string): boolean {
    return this.restoredWindowStateById.has(windowId);
  }

  public isActive(): boolean {
    return this.activeWorkspaceIndex(this.monitor) === this.index;
  }

  public refreshUsableAreaLayout() {
    if (!COMPOSITOR.output.list.includes(this.monitor)) {
      return;
    }

    if (this.isTiled) {
      const nextViewportRect = this.tileViewportRect();
      if (
        this.lastAppliedTileViewportRect &&
        managedRectEquals(this.lastAppliedTileViewportRect, nextViewportRect)
      ) {
        return;
      }
      this.applyLayout({
        suppressSSDRebuild: false,
        animate: false,
        preserveMissingActive: true,
      });
      return;
    }

    for (const window of this.windows) {
      if (!window.state[WINDOW_STATE_MAXIMIZED]()) {
        continue;
      }
      stopRectAnimation(window, WINDOW_STATE_RECT);
      window.state[WINDOW_STATE_RECT].set(this.maximizedRootRect(window));
    }
  }

  public setVisible(visible: boolean) {
    this.visibilityAnimationToken += 1;
    for (const window of this.windows) {
      this.syncWindowVisibleOutputs(window);
      if (window.state[WINDOW_STATE_TILE_DRAGGING]()) {
        window.state[WINDOW_STATE_WORKSPACE_VISIBLE].set(true);
        window.state[WINDOW_STATE_WORKSPACE_OFFSET_Y].set(0);
        window.state[WINDOW_STATE_WORKSPACE_OPACITY].set(1);
        continue;
      }
      window.state[WINDOW_STATE_WORKSPACE_VISIBLE].set(visible);
      window.state[WINDOW_STATE_WORKSPACE_OFFSET_Y].set(0);
      window.state[WINDOW_STATE_WORKSPACE_OPACITY].set(visible ? 1 : 0);
    }
  }

  public prepareWorkspaceTransition(offsetY: number, opacity: number) {
    this.visibilityAnimationToken += 1;
    for (const window of this.windows) {
      this.syncWindowVisibleOutputs(window);
      if (window.state[WINDOW_STATE_TILE_DRAGGING]()) {
        window.state[WINDOW_STATE_WORKSPACE_VISIBLE].set(true);
        window.state[WINDOW_STATE_WORKSPACE_OFFSET_Y].set(0);
        window.state[WINDOW_STATE_WORKSPACE_OPACITY].set(1);
        continue;
      }
      window.state[WINDOW_STATE_WORKSPACE_VISIBLE].set(true);
      window.state[WINDOW_STATE_WORKSPACE_OFFSET_Y].set(offsetY);
      window.state[WINDOW_STATE_WORKSPACE_OPACITY].set(opacity);
    }
  }

  public setWorkspaceGestureVisual(offsetY: number, opacity: number) {
    this.visibilityAnimationToken += 1;
    for (const window of this.windows) {
      this.syncWindowVisibleOutputs(window);
      cancelWorkspaceVisualAnimation(window);
      if (window.state[WINDOW_STATE_TILE_DRAGGING]()) {
        window.state[WINDOW_STATE_WORKSPACE_VISIBLE].set(true);
        window.state[WINDOW_STATE_WORKSPACE_OFFSET_Y].set(0);
        window.state[WINDOW_STATE_WORKSPACE_OPACITY].set(1);
        continue;
      }
      window.state[WINDOW_STATE_WORKSPACE_VISIBLE].set(true);
      window.state[WINDOW_STATE_WORKSPACE_OFFSET_Y].set(offsetY);
      window.state[WINDOW_STATE_WORKSPACE_OPACITY].set(opacity);
    }
  }

  public animateWorkspaceTransition(options: {
    fromOffsetY: number;
    toOffsetY: number;
    fromOpacity: number;
    toOpacity: number;
    visibleAfter: boolean;
  }) {
    const token = this.visibilityAnimationToken + 1;
    this.visibilityAnimationToken = token;

    for (const window of this.windows) {
      this.syncWindowVisibleOutputs(window);
      if (window.state[WINDOW_STATE_TILE_DRAGGING]()) {
        window.state[WINDOW_STATE_WORKSPACE_VISIBLE].set(true);
        window.state[WINDOW_STATE_WORKSPACE_OFFSET_Y].set(0);
        window.state[WINDOW_STATE_WORKSPACE_OPACITY].set(1);
        continue;
      }
      // Same ordering rule as prepare: schedule first, then flip
      // VISIBLE. For from-workspace this is mostly a no-op (VISIBLE was
      // already true), but for to-workspace's second call this keeps
      // the same invariant in case prepareWorkspaceTransition's hold
      // animation has already completed (e.g., rapid switches).
      scheduleWorkspaceVisualAnimation(
        window,
        options.fromOffsetY,
        options.toOffsetY,
        options.fromOpacity,
        options.toOpacity,
        WINDOW_MANAGEMENT_EASING,
        WORKSPACE_SWITCH_ANIMATION_DURATION,
      );
      window.state[WINDOW_STATE_WORKSPACE_VISIBLE].set(true);
    }

    const VISIBILITY_COMMIT_BEFORE_END_MS = 32;

    setTimeout(
      () => {
        if (this.visibilityAnimationToken !== token) {
          return;
        }
        withManagedWindowOnlySSDRebuildSuppressed(() => {
          this.setVisible(options.visibleAfter);
        });
      },
      Math.max(
        0,
        WORKSPACE_SWITCH_ANIMATION_DURATION - VISIBILITY_COMMIT_BEFORE_END_MS,
      ),
    );
  }

  public setTiled(tiled: boolean) {
    if (this.isTiled === tiled) {
      return;
    }

    this.stopKineticScroll();

    const focusedWindow = this.focusedWindow();
    const focusedTileableWindow =
      focusedWindow &&
      this.shouldTile(focusedWindow) &&
      !focusedWindow.state[WINDOW_STATE_MINIMIZED]()
        ? focusedWindow
        : undefined;
    this.isTiled = tiled;
    if (tiled) {
      this.scrollOffset = 0;
      for (const window of this.windows) {
        this.syncWindowVisibleOutputs(window);
      }
      for (const window of this.tileableWindows()) {
        this.captureFloatingRect(window);
      }
      for (const window of this.floatingWindows()) {
        this.captureFloatingRect(window);
      }
      const tileable = this.tileableWindows();
      const previousActiveWindow = this.activeWindow(tileable);
      this.activeWindowId =
        (focusedTileableWindow ?? previousActiveWindow ?? tileable.at(0))?.id ??
        null;
      if (focusedTileableWindow) {
        this.scrollToWindow(focusedTileableWindow);
      }
      this.applyLayout();
      focusedTileableWindow?.focus();
      return;
    }

    for (const window of this.windows) {
      // A window that is still maximized across the mode switch keeps its
      // maximized rect. Restoring FLOATING_RECT here would configure the
      // client to the rect captured at first commit (often degenerate),
      // collapsing it to its minimum size. (Chrome and friends remember
      // their previous session state and start maximized, which makes this
      // easy to hit.)
      if (window.state[WINDOW_STATE_MAXIMIZED]()) {
        playRectAnimation(
          window,
          WINDOW_STATE_RECT,
          this.maximizedRootRect(window),
          WINDOW_MANAGEMENT_EASING,
          WINDOW_MANAGEMENT_ANIMATION_DURATION,
          MANAGED_WINDOW_ONLY_ANIMATION,
        );
        window.state[WINDOW_STATE_FLOATING_RECT].set(null);
        this.syncWindowVisibleOutputs(window);
        continue;
      }
      const rect = window.state[WINDOW_STATE_FLOATING_RECT]();
      if (rect) {
        const viewportRect = this.shouldTile(window)
          ? rect
          : this.floatingContentRectToViewportRect(rect);
        playRectAnimation(
          window,
          WINDOW_STATE_RECT,
          viewportRect,
          WINDOW_MANAGEMENT_EASING,
          WINDOW_MANAGEMENT_ANIMATION_DURATION,
          MANAGED_WINDOW_ONLY_ANIMATION,
        );
      }
      window.state[WINDOW_STATE_FLOATING_RECT].set(null);
      this.syncWindowVisibleOutputs(window);
    }
    if (focusedTileableWindow) {
      this.activeWindowId = focusedTileableWindow.id;
      focusedTileableWindow.focus();
    }
  }

  public applyLayout(options: LayoutOptions = {}) {
    if (!this.isTiled) {
      return;
    }

    const tileable = this.tileableWindows();
    const animate = options.animate ?? true;
    const suppressSSDRebuild = options.suppressSSDRebuild ?? true;
    const canSuppress = this.canSuppressLayoutSSDRebuild(tileable);
    const animationOptions =
      animate && suppressSSDRebuild && canSuppress
        ? MANAGED_WINDOW_ONLY_ANIMATION
        : undefined;

    if (tileable.length === 0) {
      this.activeWindowId = null;
      hotReloadDebug("workspace-apply-layout-empty", {
        monitor: this.monitor,
        index: this.index,
        animate,
        suppressSSDRebuild,
        canSuppress,
        floatingWindowIds: this.floatingWindows().map((window) => window.id),
      });
      this.applyFloatingLayout(animationOptions, animate);
      return;
    }

    if (
      !this.activeWindowId ||
      !tileable.some((window) => window.id === this.activeWindowId)
    ) {
      if (!options.preserveMissingActive) {
        this.activeWindowId = tileable.at(-1)?.id ?? null;
      }
    }

    this.clampScrollOffset(tileable.length);

    const viewportRect = this.tileViewportRect();
    this.lastAppliedTileViewportRect = snapshotManagedRect(viewportRect);
    const tileHeight = read(viewportRect.height);
    let nextX = read(viewportRect.x) - this.scrollOffset;
    const appliedRects: Record<string, ManagedWindowRect> = {};
    this.lastDraggingSlotRect = null;

    tileable.forEach((window, index) => {
      const tileWidth = this.tileWidthForWindow(
        window,
        viewportRect,
        tileable.length,
      );
      const rect = window.state[WINDOW_STATE_FULLSCREEN]()
        ? this.fullscreenRootRect(window)
        : window.state[WINDOW_STATE_MAXIMIZED]()
          ? this.maximizedTileRect(window, nextX)
          : {
              x: nextX,
              y: read(viewportRect.y),
              width: tileWidth,
              height: tileHeight,
            };
      appliedRects[window.id] = rect;
      if (window.id === this.draggingWindowId) {
        this.lastDraggingSlotRect = rect;
      }
      if (window.id !== this.draggingWindowId) {
        if (animate) {
          playRectAnimation(
            window,
            WINDOW_STATE_RECT,
            rect,
            WINDOW_MANAGEMENT_EASING,
            TILE_ANIMATION_DURATION,
            animationOptions,
          );
        } else {
          if (options.cancelRectAnimations !== false) {
            stopRectAnimation(window, WINDOW_STATE_RECT);
          }
          window.state[WINDOW_STATE_RECT].set(rect);
        }
      }
      nextX += tileWidth + (index === tileable.length - 1 ? 0 : TILE_GAP);
    });

    hotReloadDebug("workspace-apply-layout", {
      monitor: this.monitor,
      index: this.index,
      animate,
      suppressSSDRebuild,
      canSuppress,
      activeWindowId: this.activeWindowId,
      scrollOffset: this.scrollOffset,
      tileableWindowIds: tileable.map((window) => window.id),
      floatingWindowIds: this.floatingWindows().map((window) => window.id),
      appliedRects,
    });
    this.applyFloatingLayout(animationOptions, animate);
  }

  /** Layout slot reserved for the tile being dragged, or null when not dragging. */
  public draggingSlotRect(): ManagedWindowRect | null {
    return this.draggingWindowId ? this.lastDraggingSlotRect : null;
  }

  public beginTileDrag(window: WaylandWindow, rect: ManagedWindowRect) {
    if (!this.shouldTile(window)) {
      return;
    }
    this.activeWindowId = window.id;
    this.draggingWindowId = window.id;
    const wasMaximized = window.state[WINDOW_STATE_MAXIMIZED]();
    window.state[WINDOW_STATE_MAXIMIZED].set(false);
    window.state[WINDOW_STATE_RESTORE_RECT].set(null);
    if (wasMaximized) {
      window.unmaximize();
    }
    window.state[WINDOW_STATE_TILE_DRAGGING].set(true);
    this.syncWindowVisibleOutputs(window);
    window.state[WINDOW_STATE_WORKSPACE_VISIBLE].set(true);
    window.state[WINDOW_STATE_WORKSPACE_OFFSET_Y].set(0);
    window.state[WINDOW_STATE_WORKSPACE_OPACITY].set(1);
    stopRectAnimation(window, WINDOW_STATE_RECT);
    window.state[WINDOW_STATE_RECT].set(rect);
    this.applyLayout();
  }

  public adoptTileDragWindow(window: WaylandWindow, rect: ManagedWindowRect) {
    if (!this.hasWindow(window)) {
      this.windows.push(window);
    }
    const visible = this.isActive();
    this.activeWindowId = window.id;
    this.draggingWindowId = window.id;
    window.state[WINDOW_STATE_TILE_DRAGGING].set(true);
    this.syncWindowVisibleOutputs(window);
    window.state[WINDOW_STATE_WORKSPACE_VISIBLE].set(true);
    window.state[WINDOW_STATE_WORKSPACE_OFFSET_Y].set(0);
    window.state[WINDOW_STATE_WORKSPACE_OPACITY].set(visible ? 1 : 0);
    stopRectAnimation(window, WINDOW_STATE_RECT);
    window.state[WINDOW_STATE_RECT].set(rect);
  }

  public adoptFloatingWindow(window: WaylandWindow, rect: ManagedWindowRect) {
    if (!this.hasWindow(window)) {
      this.windows.push(window);
    }
    const visible = this.isActive();
    this.activeWindowId = window.id;
    this.syncWindowVisibleOutputs(window);
    resetWorkspaceVisualState(window, visible);
    window.state[WINDOW_STATE_FLOATING_RECT].set(
      this.isTiled ? this.viewportRectToFloatingContentRect(rect) : rect,
    );
    stopRectAnimation(window, WINDOW_STATE_RECT);
    window.state[WINDOW_STATE_RECT].set(rect);
  }

  public updateTileDrag(
    window: WaylandWindow,
    rect: ManagedWindowRect,
    pointerX: number,
  ) {
    if (this.draggingWindowId !== window.id) {
      this.beginTileDrag(window, rect);
    }
    this.activeWindowId = window.id;
    this.moveTileWindowToIndex(
      window,
      this.tileInsertionIndexForPointer(window, pointerX),
    );
    stopRectAnimation(window, WINDOW_STATE_RECT);
    window.state[WINDOW_STATE_RECT].set(rect);
    this.scrollToWindow(window);
    this.applyLayout();
  }

  public endTileDrag(window: WaylandWindow, cancelled: boolean) {
    if (this.draggingWindowId !== window.id) {
      return;
    }
    this.draggingWindowId = null;
    window.state[WINDOW_STATE_TILE_DRAGGING].set(false);
    this.syncWindowVisibleOutputs(window);
    window.state[WINDOW_STATE_WORKSPACE_OFFSET_Y].set(0);
    window.state[WINDOW_STATE_WORKSPACE_OPACITY].set(this.isActive() ? 1 : 0);
    if (!cancelled) {
      this.activeWindowId = window.id;
      this.scrollToWindow(window);
    }
    this.applyLayout();
    if (!cancelled && this.isActive()) {
      window.focus();
    }
  }

  public focusWindow(window: WaylandWindow) {
    if (!this.shouldTile(window)) {
      return;
    }
    if (this.activeWindowId === window.id) {
      return;
    }
    this.activeWindowId = window.id;
    this.scrollToWindow(window);
    this.applyLayout();
  }

  /**
   * "Go to this window": center the target in the viewport (overriding the
   * normal `scrollToWindow` which is a no-op when already visible) and animate
   * the layout. Used by dock clicks and any other "jump to window" gesture.
   */
  public panToWindow(window: WaylandWindow) {
    if (!this.isTiled) {
      return;
    }
    if (!this.shouldTile(window)) {
      return;
    }
    this.activeWindowId = window.id;
    this.scrollToWindow(window, { force: true });
    this.applyLayout();
  }

  public focusWindowUnderPointer(window: WaylandWindow): WaylandWindow | undefined {
    if (
      !this.isTiled ||
      !this.hasWindow(window) ||
      window.state[WINDOW_STATE_MINIMIZED]()
    ) {
      return undefined;
    }

    const focused = this.focusedWindow();
    if (
      focused &&
      focused.id !== window.id &&
      this.areTransientRelatives(focused, window)
    ) {
      return undefined;
    }

    if (read(window.isFocused)) {
      return undefined;
    }

    if (this.shouldTile(window)) {
      const previousActiveWindowId = this.activeWindowId;
      this.activeWindowId = window.id;
      if (previousActiveWindowId !== window.id) {
        this.reapplyStaticManagedLayout();
      }
    }
    window.focus();
    return window;
  }

  private areTransientRelatives(a: WaylandWindow, b: WaylandWindow): boolean {
    return (
      this.isTransientChildOf(a, b) ||
      this.isTransientChildOf(b, a) ||
      this.hasUnparentedTransientAffinity(a, b)
    );
  }

  private isTransientChildOf(
    child: WaylandWindow,
    parent: WaylandWindow,
  ): boolean {
    return child.isTransient() && child.parentId() === parent.id;
  }

  private hasUnparentedTransientAffinity(
    a: WaylandWindow,
    b: WaylandWindow,
  ): boolean {
    const transient = !this.shouldTile(a) && a.isTransient() ? a : null;
    const other =
      transient === a ? b : !this.shouldTile(b) && b.isTransient() ? b : null;
    if (!transient || !other || transient.parentId()) {
      return false;
    }

    const transientAppId = transient.appId();
    return transientAppId !== undefined && transientAppId === other.appId();
  }

  private reapplyStaticManagedLayout(): void {
    if (!this.isTiled) {
      return;
    }

    const tileable = this.tileableWindows();
    if (tileable.length === 0) {
      return;
    }

    withManagedWindowOnlySSDRebuildSuppressed(
      () => {
        this.applyLayout({
          animate: false,
          preserveMissingActive: true,
          cancelRectAnimations: false,
        });
      },
      { strict: true },
    );
    for (const window of tileable) {
      markManagedWindowDirty(window.id);
    }
  }

  public scrollBy(
    deltaX: number,
    options: {
      stopKinetic?: boolean;
      suppressSSDRebuild?: boolean;
      cancelRectAnimations?: boolean;
    } = {},
  ): boolean {
    if (!this.isTiled || deltaX === 0) {
      return false;
    }
    if (options.stopKinetic !== false) {
      this.stopKineticScroll();
    }

    const before = this.scrollOffset;
    this.scrollOffset += deltaX;
    const tileable = this.tileableWindows();
    this.clampScrollOffset(tileable.length);
    if (this.scrollOffset === before) {
      return false;
    }

    const cancelRectAnimations = options.cancelRectAnimations ?? true;
    const apply = () =>
      this.applyLayout({
        animate: false,
        preserveMissingActive: true,
        cancelRectAnimations,
      });
    if (options.suppressSSDRebuild === false) {
      apply();
    } else {
      withManagedWindowOnlySSDRebuildSuppressed(apply, { strict: true });
    }
    for (const window of tileable) {
      markManagedWindowDirty(window.id);
    }
    return true;
  }

  public startKineticScroll(
    initialVelocityX: number,
    onFrame?: () => void,
  ): void {
    this.stopKineticScroll();
    if (
      !this.isTiled ||
      Math.abs(initialVelocityX) < WORKSPACE_KINETIC_SCROLL_MIN_VELOCITY
    ) {
      return;
    }

    let velocityX = clamp(
      initialVelocityX,
      -WORKSPACE_KINETIC_SCROLL_MAX_VELOCITY,
      WORKSPACE_KINETIC_SCROLL_MAX_VELOCITY,
    );
    let lastTime: number | null = null;
    const token = this.kineticScrollToken + 1;
    this.kineticScrollToken = token;
    const intervalMs = this.kineticScrollIntervalMs();
    let firstStep = true;

    const step = (dtMs: number): boolean => {
      const deltaX = (velocityX * dtMs) / 1000;
      const scrolled = this.scrollBy(deltaX, {
        stopKinetic: false,
        cancelRectAnimations: firstStep,
      });
      firstStep = false;
      if (!scrolled) {
        this.stopKineticScroll();
        return false;
      }

      onFrame?.();

      velocityX *= Math.exp(-dtMs / WORKSPACE_KINETIC_SCROLL_TIME_CONSTANT_MS);
      if (Math.abs(velocityX) < WORKSPACE_KINETIC_SCROLL_STOP_VELOCITY) {
        this.stopKineticScroll();
        return false;
      }

      return true;
    };

    if (!step(intervalMs)) {
      return;
    }

    this.kineticScrollPoll = createManagedPoll(
      intervalMs,
      (handle) => {
        if (this.kineticScrollToken !== token || !this.isTiled) {
          handle.cancel();
          if (this.kineticScrollPoll === handle) {
            this.kineticScrollPoll = null;
          }
          return;
        }

        const now = handle.nowMs;
        const dtMs = Math.max(
          1,
          lastTime === null ? intervalMs : now - lastTime,
        );
        lastTime = now;
        step(dtMs);
      },
      "none",
    );
  }

  public stopKineticScroll(): void {
    this.kineticScrollToken += 1;
    if (this.kineticScrollPoll) {
      this.kineticScrollPoll.cancel();
      this.kineticScrollPoll = null;
    }
  }

  private kineticScrollIntervalMs(): number {
    const refreshRate =
      COMPOSITOR.output.current[this.monitor]?.resolution?.refreshRate ??
      WORKSPACE_KINETIC_SCROLL_FALLBACK_REFRESH_RATE;
    return 1000 / Math.max(1, refreshRate);
  }

  public focusRelative(direction: -1 | 1) {
    const tileable = this.tileableWindows();
    if (tileable.length === 0) {
      return;
    }
    const activeIndex = tileable.findIndex(
      (window) => window.id === this.activeWindowId,
    );
    const fallbackIndex = this.focusFallbackTileIndex(tileable, direction);
    const currentIndex =
      activeIndex >= 0
        ? activeIndex
        : (fallbackIndex ?? (direction < 0 ? tileable.length : -1));
    const nextIndex = clamp(currentIndex + direction, 0, tileable.length - 1);
    this.activeWindowId = tileable[nextIndex].id;
    this.scrollToWindow(tileable[nextIndex]);
    this.applyLayout();
    this.focusActiveWindow();
  }

  private focusFallbackTileIndex(
    tileable: WaylandWindow[],
    direction: -1 | 1,
  ): number | undefined {
    const focused = this.focusedWindow();
    if (!focused || this.shouldTile(focused)) {
      return undefined;
    }

    const focusedCenter = rectCenterX(focused.state[WINDOW_STATE_RECT]());
    const candidates = tileable
      .map((window, index) => ({
        index,
        center: rectCenterX(window.state[WINDOW_STATE_RECT]()),
      }))
      .filter(({ center }) =>
        direction < 0 ? center < focusedCenter : center > focusedCenter,
      );
    if (candidates.length === 0) {
      return undefined;
    }

    candidates.sort((a, b) =>
      direction < 0 ? b.center - a.center : a.center - b.center,
    );
    return candidates[0].index - direction;
  }

  public focusActiveWindow() {
    const active = this.windows.find(
      (window) => window.id === this.activeWindowId,
    );
    active?.focus();
  }

  public shouldTile(window: WaylandWindow): boolean {
    return window.isResizable() && !window.isTransient();
  }

  public snapshot(): WorkspaceSnapshot {
    return {
      monitor: this.monitor,
      index: this.index,
      isTiled: this.isTiled,
      activeWindowId: this.activeWindowId,
      scrollOffset: this.scrollOffset,
      windows: this.windows.map((window) => this.snapshotWindow(window)),
    };
  }

  public restore(snapshot: WorkspaceSnapshot) {
    this.isTiled = snapshot.isTiled;
    this.activeWindowId = snapshot.activeWindowId;
    this.scrollOffset = snapshot.scrollOffset;
    this.restoredWindowStateById.clear();
    for (const window of snapshot.windows) {
      this.restoredWindowStateById.set(window.id, window);
    }
    hotReloadDebug("workspace-restore", {
      monitor: this.monitor,
      index: this.index,
      isTiled: this.isTiled,
      activeWindowId: this.activeWindowId,
      scrollOffset: this.scrollOffset,
      restoredWindowIds: Array.from(this.restoredWindowStateById.keys()),
    });
  }

  public getWindows(): WaylandWindow[] {
    return Array.from(this.windows);
  }

  private snapshotWindow(window: WaylandWindow): WorkspaceWindowSnapshot {
    return {
      id: window.id,
      floatingRect: window.state[WINDOW_STATE_FLOATING_RECT](),
      restoreRect: window.state[WINDOW_STATE_RESTORE_RECT](),
      snapZone: window.state[WINDOW_STATE_SNAP_ZONE](),
      snapMonitor: window.state[WINDOW_STATE_SNAP_MONITOR](),
      minimized: window.state[WINDOW_STATE_MINIMIZED](),
      maximized: window.state[WINDOW_STATE_MAXIMIZED](),
    };
  }

  private syncWindowVisibleOutputs(window: WaylandWindow) {
    window.state[WINDOW_STATE_TILED].set(this.isTiled && this.shouldTile(window));
    window.state[WINDOW_STATE_VISIBLE_OUTPUTS].set(
      this.isTiled ? [this.monitor] : null,
    );
  }

  private canSuppressLayoutSSDRebuild(_tileable: WaylandWindow[]): boolean {
    // Opening windows may still be building decoration structure, labels,
    // icons, and shader inputs. SSD rebuild suppression is global, so using
    // it for existing windows' layout animation would also hide those
    // initial decoration updates until an unrelated interaction occurs.
    return true;
  }

  private tileableWindows(): WaylandWindow[] {
    return this.windows.filter(
      (window) =>
        this.shouldTile(window) && !window.state[WINDOW_STATE_MINIMIZED](),
    );
  }

  public focusedWindow(): WaylandWindow | undefined {
    return this.windows.find((window) => read(window.isFocused));
  }

  public syncFloatingWindowRect(
    window: WaylandWindow,
    viewportRect: ManagedWindowRect,
  ) {
    if (!this.isTiled) {
      window.state[WINDOW_STATE_FLOATING_RECT].set(viewportRect);
      return;
    }
    if (this.shouldTile(window)) {
      return;
    }
    window.state[WINDOW_STATE_FLOATING_RECT].set(
      this.viewportRectToFloatingContentRect(viewportRect),
    );
  }

  private activeWindow(windows = this.windows): WaylandWindow | undefined {
    return windows.find((window) => window.id === this.activeWindowId);
  }

  private tileInsertionIndexForPointer(
    window: WaylandWindow,
    pointerX: number,
  ): number {
    const tileable = this.tileableWindows().filter(
      (current) => current.id !== window.id,
    );
    const viewportRect = this.tileViewportRect();
    const contentX = pointerX - read(viewportRect.x) + this.scrollOffset;
    let left = 0;

    for (let index = 0; index < tileable.length; index++) {
      const width = this.tileWidthForWindow(
        tileable[index],
        viewportRect,
        tileable.length,
      );
      if (contentX < left + width / 2) {
        return index;
      }
      left += width + TILE_GAP;
    }

    return tileable.length;
  }

  private moveTileWindowToIndex(window: WaylandWindow, tileIndex: number) {
    const currentIndex = this.windows.findIndex(
      (current) => current.id === window.id,
    );
    if (currentIndex < 0) {
      return;
    }

    this.windows.splice(currentIndex, 1);
    const tileableWithoutWindow = this.tileableWindows();
    const beforeWindow = tileableWithoutWindow[tileIndex];

    if (beforeWindow) {
      const insertIndex = this.windows.findIndex(
        (current) => current.id === beforeWindow.id,
      );
      this.windows.splice(Math.max(0, insertIndex), 0, window);
      return;
    }

    let lastTileableIndex = -1;
    for (let index = 0; index < this.windows.length; index++) {
      if (this.shouldTile(this.windows[index])) {
        lastTileableIndex = index;
      }
    }
    this.windows.splice(lastTileableIndex + 1, 0, window);
  }

  private captureFloatingRect(window: WaylandWindow) {
    if (!window.state[WINDOW_STATE_FLOATING_RECT]()) {
      const rect = this.isTiled
        ? this.viewportRectToFloatingContentRect(
            window.state[WINDOW_STATE_RECT](),
          )
        : window.state[WINDOW_STATE_RECT]();
      window.state[WINDOW_STATE_FLOATING_RECT].set(rect);
    }
  }

  public floatingWindows(): WaylandWindow[] {
    return this.windows.filter(
      (window) =>
        !this.shouldTile(window) && !window.state[WINDOW_STATE_MINIMIZED](),
    );
  }

  private applyFloatingLayout(
    animationOptions: LayoutOptions | undefined,
    animate = true,
  ) {
    for (const window of this.floatingWindows()) {
      // A maximized window's rect is owned by the maximize flow. Rolling it
      // back to FLOATING_RECT here could hit a degenerate rect (same reason
      // as in setTiled(false)).
      if (window.state[WINDOW_STATE_MAXIMIZED]()) {
        continue;
      }
      const contentRect =
        window.state[WINDOW_STATE_FLOATING_RECT]() ??
        this.viewportRectToFloatingContentRect(
          this.centeredFloatingRect(window),
        );
      window.state[WINDOW_STATE_FLOATING_RECT].set(contentRect);
      const rect = this.floatingContentRectToViewportRect(contentRect);
      if (animate) {
        playRectAnimation(
          window,
          WINDOW_STATE_RECT,
          rect,
          WINDOW_MANAGEMENT_EASING,
          TILE_ANIMATION_DURATION,
          animationOptions,
        );
      } else {
        stopRectAnimation(window, WINDOW_STATE_RECT);
        window.state[WINDOW_STATE_RECT].set(rect);
      }
      hotReloadDebug("workspace-apply-floating-layout", {
        monitor: this.monitor,
        index: this.index,
        animate,
        windowId: window.id,
        rect,
        contentRect,
      });
    }
  }

  private centeredFloatingRect(window: WaylandWindow): ManagedWindowRect {
    const sizeRect = this.naturalRootRect(window);
    const monitor = COMPOSITOR.output.current[this.monitor];
    if (!monitor?.resolution) {
      return sizeRect;
    }

    const usableRect = COMPOSITOR.layer.usableArea(this.monitor);
    const logicalWidth =
      usableRect?.width ?? monitor.resolution.width / monitor.scale;
    const logicalHeight =
      usableRect?.height ?? monitor.resolution.height / monitor.scale;
    const logicalX = usableRect?.x ?? monitor.position.x;
    const logicalY = usableRect?.y ?? monitor.position.y;

    let width = read(sizeRect.width);
    let height = read(sizeRect.height);
    // Reading the natural size while the client geometry is still unsettled
    // (≈0, e.g. right after the first commit) yields a degenerate rect that
    // is nothing but the SSD frame. Freezing that as the floating restore
    // rect would later configure the client to a tiny size when switching to
    // floating mode. Fall back to a default size based on the usable area
    // only when the rect is clearly degenerate (frame + titlebar at most).
    // 50px is a conservative threshold that no real app's natural size ever
    // falls under.
    const DEGENERATE_SIZE_PX = 50;
    if (width < DEGENERATE_SIZE_PX || height < DEGENERATE_SIZE_PX) {
      width = Math.round(logicalWidth * 0.6);
      height = Math.round(logicalHeight * 0.7);
    }

    return {
      x: logicalX + (logicalWidth - width) / 2,
      y: logicalY + (logicalHeight - height) / 2,
      width,
      height,
    };
  }

  private viewportRectToFloatingContentRect(
    rect: ManagedWindowRect,
  ): ManagedWindowRect {
    return {
      x: read(rect.x) + this.scrollOffset,
      y: read(rect.y),
      width: read(rect.width),
      height: read(rect.height),
    };
  }

  private floatingContentRectToViewportRect(
    rect: ManagedWindowRect,
  ): ManagedWindowRect {
    return {
      x: read(rect.x) - this.scrollOffset,
      y: read(rect.y),
      width: read(rect.width),
      height: read(rect.height),
    };
  }

  private clampRectToViewport(rect: ManagedWindowRect): ManagedWindowRect {
    const viewport = this.tileViewportRect();
    const width = read(rect.width);
    const height = read(rect.height);
    const minX = read(viewport.x);
    const minY = read(viewport.y);
    const maxX = minX + Math.max(0, read(viewport.width) - width);
    const maxY = minY + Math.max(0, read(viewport.height) - height);
    return {
      x: clamp(read(rect.x), minX, maxX),
      y: clamp(read(rect.y), minY, maxY),
      width,
      height,
    };
  }

  private scrollToWindow(
    window: WaylandWindow,
    options: { force?: boolean } = {},
  ) {
    this.stopKineticScroll();

    const tileable = this.tileableWindows();
    const index = tileable.findIndex((current) => current.id === window.id);
    if (index < 0) {
      return;
    }

    const viewportRect = this.tileViewportRect();
    const viewportWidth = read(viewportRect.width);
    const windowLeft = this.tileLeftForIndex(tileable, index, viewportRect);
    const windowRight =
      windowLeft +
      this.tileWidthForWindow(window, viewportRect, tileable.length);

    if (window.state[WINDOW_STATE_MAXIMIZED]() || options.force) {
      // Center the window in the viewport. `force` is set by dock-style "go to
      // this window" requests where we always want a visible pan, even when
      // the target is already on-screen.
      this.scrollOffset =
        windowLeft + (windowRight - windowLeft) / 2 - viewportWidth / 2;
    } else if (windowLeft < this.scrollOffset) {
      this.scrollOffset = windowLeft;
    } else if (windowRight > this.scrollOffset + viewportWidth) {
      this.scrollOffset = windowRight - viewportWidth;
    }

    this.clampScrollOffset(tileable.length);
  }

  private clampScrollOffset(tileCount: number) {
    const tileable = this.tileableWindows();
    const viewportRect = this.tileViewportRect();
    const viewportWidth = read(viewportRect.width);
    const contentWidth = this.tileContentWidth(
      tileable.slice(0, tileCount),
      viewportRect,
    );
    const maxScrollOffset = Math.max(0, contentWidth - viewportWidth);
    this.scrollOffset = clamp(this.scrollOffset, 0, maxScrollOffset);
  }

  private tileWidthForWindow(
    window: WaylandWindow,
    viewportRect: ManagedWindowRect,
    tileCount: number,
  ): number {
    if (window.state[WINDOW_STATE_MAXIMIZED]()) {
      return read(this.maximizedRootRect(window).width);
    }

    const visibleCols = Math.max(1, Math.min(tileCount, TILE_MAX_COLUMNS));
    const colWidth =
      (read(viewportRect.width) - (visibleCols - 1) * TILE_GAP) / visibleCols;
    const minWidth = this.minTileWidth(window, viewportRect);
    return clamp(
      colWidth,
      minWidth,
      Math.max(minWidth, this.maxTileWidth(window)),
    );
  }

  private maximizedTileRect(
    window: WaylandWindow,
    x: number,
  ): ManagedWindowRect {
    const maximizedRect = this.maximizedRootRect(window);
    return {
      x,
      y: read(maximizedRect.y),
      width: read(maximizedRect.width),
      height: read(maximizedRect.height),
    };
  }

  private minTileWidth(
    window: WaylandWindow,
    viewportRect: ManagedWindowRect,
  ): number {
    const constraints = window.sizeConstraints();
    const extra = this.rootClientWidthExtra(window);
    return Math.max(
      TILE_MIN_WIDTH,
      (constraints.min?.width ?? 1) + extra,
      read(viewportRect.width) * 0.2,
    );
  }

  private maxTileWidth(window: WaylandWindow): number {
    const constraints = window.sizeConstraints();
    const extra = this.rootClientWidthExtra(window);
    const max = constraints.max?.width;
    return max && max > 0 ? max + extra : Number.POSITIVE_INFINITY;
  }

  private rootClientWidthExtra(window: WaylandWindow): number {
    const natural = this.naturalRootRect(window);
    return Math.max(0, read(natural.width) - window.position.width);
  }

  private tileLeftForIndex(
    tileable: WaylandWindow[],
    index: number,
    viewportRect: ManagedWindowRect,
  ): number {
    let left = 0;
    for (let i = 0; i < index; i++) {
      left +=
        this.tileWidthForWindow(tileable[i], viewportRect, tileable.length) +
        TILE_GAP;
    }
    return left;
  }

  private tileContentWidth(
    tileable: WaylandWindow[],
    viewportRect: ManagedWindowRect,
  ): number {
    if (tileable.length === 0) {
      return 0;
    }
    return (
      tileable.reduce(
        (sum, window) =>
          sum +
          this.tileWidthForWindow(window, viewportRect, tileable.length),
        0,
      ) +
      (tileable.length - 1) * TILE_GAP
    );
  }

  private tileViewportRect(): ManagedWindowRect {
    const monitor = COMPOSITOR.output.current[this.monitor];
    const usableRect = COMPOSITOR.layer.usableArea(this.monitor);
    const base =
      usableRect ??
      (monitor?.resolution
        ? {
            x: monitor.position.x,
            y: monitor.position.y,
            width: monitor.resolution.width / monitor.scale,
            height: monitor.resolution.height / monitor.scale,
          }
        : {
            x: 0,
            y: 0,
            width: 1280,
            height: 720,
          });

    return insetRect(base, {
      top: TILE_GAP,
      right: TILE_GAP,
      bottom: TILE_GAP,
      left: TILE_GAP,
    });
  }

  private fullscreenRootRect(window: WaylandWindow): ManagedWindowRect {
    const monitor = COMPOSITOR.output.current[this.monitor];
    if (monitor?.resolution) {
      return {
        x: monitor.position.x,
        y: monitor.position.y,
        width: monitor.resolution.width / monitor.scale,
        height: monitor.resolution.height / monitor.scale,
      };
    }
    return window.state[WINDOW_STATE_RECT]();
  }
}

