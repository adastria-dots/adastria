import {
  COMPOSITOR,
  createManagedPoll,
  createWindowStack,
  createWindowState,
  cubicBezier,
  dropWindowState,
  markManagedWindowDirty,
  markWindowDirty,
  read,
  seconds,
  type EasingFunction,
  type GestureSwipeEvent,
  type OutputChangeEvent,
  type PointerMoveEvent,
  type PollHandle,
  type ReadonlySignal,
  type WaylandWindow,
  type WindowActivateRequestEvent,
  type WindowFullscreenRequestEvent,
  type WindowMaximizeRequestEvent,
  type WindowMinimizeRequestEvent,
  type WindowMoveEvent,
  type WindowResizeEvent,
  type WindowResizeRect,
} from "shoji_wm";
import type { ManagedWindowRect, WindowSizeConstraints } from "shoji_wm/types";
import { playRectAnimation, stopRectAnimation } from "./window-animation";

// =======================
// GEOMETRY & RECT HELPERS
// =======================
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
export function insetRect(
  rect: ManagedWindowRect,
  padding: { top: number; right: number; bottom: number; left: number },
): ManagedWindowRect {
  const width = Math.max(1, read(rect.width) - padding.left - padding.right);
  const height = Math.max(1, read(rect.height) - padding.top - padding.bottom);
  return {
    x: read(rect.x) + padding.left,
    y: read(rect.y) + padding.top,
    width,
    height,
  };
}
export function workspaceKey(monitor: string, index: number): string {
  return `${monitor}:${index}`;
}
export function constrainedMax(
  constraints: WindowSizeConstraints,
  axis: "width" | "height",
  extra: number,
): number {
  const max = constraints.max?.[axis];
  return max && max > 0 ? max + extra : Number.POSITIVE_INFINITY;
}
export function resizeOriginForAxis(
  start: WindowResizeRect,
  current: WindowResizeRect,
  constrainedSize: number,
  negativeEdge: boolean,
  axis: "x" | "y",
): number {
  if (!negativeEdge) {
    return current[axis];
  }

  const startSize = axis === "x" ? start.width : start.height;
  return start[axis] + startSize - constrainedSize;
}
export function managedRectContainsPoint(
  rect: ManagedWindowRect,
  x: number,
  y: number,
): boolean {
  const left = read(rect.x);
  const top = read(rect.y);
  return (
    x >= left &&
    x < left + read(rect.width) &&
    y >= top &&
    y < top + read(rect.height)
  );
}
export function rectCenterX(rect: ManagedWindowRect): number {
  return read(rect.x) + read(rect.width) / 2;
}
export function snapshotManagedRect(rect: ManagedWindowRect): ManagedWindowRect {
  return {
    x: read(rect.x),
    y: read(rect.y),
    width: read(rect.width),
    height: read(rect.height),
  };
}
export function managedRectEquals(
  a: ManagedWindowRect,
  b: ManagedWindowRect,
): boolean {
  return (
    read(a.x) === read(b.x) &&
    read(a.y) === read(b.y) &&
    read(a.width) === read(b.width) &&
    read(a.height) === read(b.height)
  );
}

// ================
// HOT RELOAD DEBUG
// ================
function hotReloadDebugEnabled(): boolean {
  const env = (globalThis as { process?: { env?: Record<string, string> } })
    .process?.env;
  const value = env?.SHOJI_HOT_RELOAD_DEBUG;
  return value !== undefined && value !== "" && value !== "0";
}

export function hotReloadDebug(
  message: string,
  details: Record<string, unknown> = {},
): void {
  if (!hotReloadDebugEnabled()) {
    return;
  }
  console.info(`hot-reload ${message}`, JSON.stringify(details));
}

// =====================================
// COMPOSITION / SSD REBUILD SUPPRESSION
// =====================================
const MANAGED_WINDOW_ONLY_REBUILD_SUPPRESSION = {
  allowManagedWindowOnly: true,
  onViolation: "fallback-last",
} as const;
const STRICT_MANAGED_WINDOW_ONLY_REBUILD_SUPPRESSION = {
  allowManagedWindowOnly: true,
  onViolation: "fallback",
} as const;
export const MANAGED_WINDOW_ONLY_ANIMATION = {
  suppressSSDRebuild: true,
} as const;
export function markWindowCompositionDirty(window: WaylandWindow): void {
  markWindowDirty(window.id);
}
export function withManagedWindowOnlySSDRebuildSuppressed<T>(
  callback: () => T,
  options: { strict?: boolean } = {},
): T {
  return COMPOSITOR.runtime.withSSDRebuildSuppressed(
    options.strict
      ? STRICT_MANAGED_WINDOW_ONLY_REBUILD_SUPPRESSION
      : MANAGED_WINDOW_ONLY_REBUILD_SUPPRESSION,
    callback,
  );
}

// ============
// WINDOW STATE
// ============
export type SnapZone =
  | "monocle"
  | "left"
  | "right"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";
export const WINDOW_STATE_RECT = createWindowState<ManagedWindowRect>("rect", {
  default: (window) => window.rect,
});
export const WINDOW_STATE_RESTORE_RECT =
  createWindowState<ManagedWindowRect | null>("restoreRect", {
    default: null,
  });
export const WINDOW_STATE_MINIMIZED = createWindowState<boolean>("minimized", {
  default: false,
});
export const WINDOW_STATE_MINIMIZE_VISUAL_IDLE = createWindowState<boolean>(
  "minimizeVisualIdle",
  {
    default: false,
  },
);
export const WINDOW_STATE_MONOCLE = createWindowState<boolean>("monocle", {
  default: false,
});
export const WINDOW_STATE_FULLSCREEN = createWindowState<boolean>(
  "fullscreen",
  {
    default: false,
  },
);
// Separate so monocle→fullscreen restores to monocle, not RESTORE_RECT.
export const WINDOW_STATE_FULLSCREEN_RESTORE_RECT =
  createWindowState<ManagedWindowRect | null>("fullscreenRestoreRect", {
    default: null,
  });
export const WINDOW_STATE_WORKSPACE_VISIBLE = createWindowState<boolean>(
  "workspaceVisible",
  {
    default: true,
  },
);
export const WINDOW_STATE_WORKSPACE_OFFSET_Y = createWindowState<number>(
  "workspaceOffsetY",
  {
    default: 0,
  },
);
export const WINDOW_STATE_WORKSPACE_OPACITY = createWindowState<number>(
  "workspaceOpacity",
  {
    default: 1,
  },
);
export const WINDOW_STATE_TILE_DRAGGING = createWindowState<boolean>(
  "tileDragging",
  {
    default: false,
  },
);
export const WINDOW_STATE_TILED = createWindowState<boolean>("tiled", {
  default: false,
});
export const WINDOW_STATE_VISIBLE_OUTPUTS = createWindowState<string[] | null>(
  "visibleOutputs",
  {
    default: null,
  },
);
export const WINDOW_STATE_FLOATING_RECT =
  createWindowState<ManagedWindowRect | null>("floatingRect", {
    default: null,
  });
export const WINDOW_STATE_SNAP_ZONE =
  createWindowState<SnapZone | null>("snapZone", {
    default: null,
  });
export const WINDOW_STATE_SNAP_MONITOR =
  createWindowState<string | null>("snapMonitor", {
    default: null,
  });
export const WINDOW_STATE_URGENT = createWindowState<boolean>("urgent", {
  default: false,
});
export const WINDOW_STATE_MANUAL_FLOAT = createWindowState<boolean>(
  "manualFloat",
  { default: false },
);

// ============================
// ANIMATION DURATIONS & EASING
// ============================
export const OPEN_CLOSE_ANIMATION_DURATION = seconds(0.3);
export const WINDOW_MANAGEMENT_ANIMATION_DURATION = seconds(0.3);
export const MONOCLE_EXIT_GRAB_ANIMATION_DURATION = 150;
export const WINDOW_MANAGEMENT_EASING = cubicBezier(0.1, 0.9, 0.2, 1.0);
export const WINDOW_OPEN_EASING = cubicBezier(0.1, 1.1, 0.1, 1.1);
export const WINDOW_CLOSE_EASING = cubicBezier(0.3, -0.3, 0, 1);
export const WINDOW_MINIMIZE_RECT_EASING = cubicBezier(0.3, -0.3, 0, 1);
export const WINDOW_UNMINIMIZE_RECT_EASING = cubicBezier(0.1, 1.1, 0.1, 1.1);
export const WINDOW_MINIMIZE_OPACITY_EASING = cubicBezier(0.3, -0.3, 0, 1);
export const WINDOW_UNMINIMIZE_OPACITY_EASING = cubicBezier(0.1, 1.1, 0.1, 1.1);
export const TILE_ANIMATION_DURATION = seconds(0.2);
export const WORKSPACE_SWITCH_ANIMATION_DURATION = seconds(0.3);

// =========================================
// WORKSPACE GESTURE & KINETIC SCROLL TUNING
// =========================================
export const WORKSPACE_GESTURE_FINGERS = 3;
export const WORKSPACE_GESTURE_AXIS_LOCK_PX = 8;
export const WORKSPACE_GESTURE_THRESHOLD_RATIO = 0.22;
export const WORKSPACE_GESTURE_VELOCITY_THRESHOLD = 900;
export const WORKSPACE_KINETIC_SCROLL_MIN_VELOCITY = 120;
export const WORKSPACE_KINETIC_SCROLL_MAX_VELOCITY = 5000;
export const WORKSPACE_KINETIC_SCROLL_STOP_VELOCITY = 18;
export const WORKSPACE_KINETIC_SCROLL_TIME_CONSTANT_MS = 360;
export const WORKSPACE_KINETIC_SCROLL_FALLBACK_REFRESH_RATE = 120;
export const TILE_DRAG_WORKSPACE_EDGE_PX = 80;
export const TILE_DRAG_WORKSPACE_SWITCH_INTERVAL_MS = 420;

// =======================
// TILING & SNAP CONSTANTS
// =======================
// Also used between tile and screen edge, so both gaps stay consistent.
export const TILE_GAP = 20;
export const TILE_MAX_COLUMNS = 2;
// Clamp for HybridWindowManager.bumpColumns' per-workspace override, mirrors
// Hyprland's scrollumns layout.lua M.bump (math.max(1, math.min(6, ...))).
export const TILE_COLUMNS_MIN = 1;
export const TILE_COLUMNS_MAX = 6;
export const WORKSPACES_PER_MONITOR = 10;
export const TILE_MIN_WIDTH = 240;
export const SNAP_EDGE_PX = 16;
export const SNAP_CORNER_PX = 140;
export const SNAP_GAP_PX = 8;

// =========================
// SNAPSHOT & IPC VIEW TYPES
// =========================
export interface SnapPreviewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SnapPreviewPayload {
  monitor: string;
  rect: SnapPreviewRect | null;
  kind: "floating" | "tiling";
}

export type SnapPreviewBroadcaster = (preview: SnapPreviewPayload) => void;
export type WorkspaceChangeBroadcaster = () => void;
export interface HybridWindowManagerSnapshot {
  currentMonitor: string;
  activeWorkspaceByMonitor: [string, number][];
  workspaces: WorkspaceSnapshot[];
}

export interface WorkspaceSnapshot {
  monitor: string;
  index: number;
  activeWindowId: string | null;
  scrollOffset: number;
  windows: WorkspaceWindowSnapshot[];
}

export interface WorkspaceWindowSnapshot {
  id: string;
  floatingRect?: ManagedWindowRect | null;
  restoreRect?: ManagedWindowRect | null;
  snapZone?: SnapZone | null;
  snapMonitor?: string | null;
  minimized: boolean;
}
export interface WorkspacesViewWindow {
  id: string;
  appId?: string;
  title: string;
  active: boolean;
  urgent: boolean;
  monocle: boolean;
  lastFocusedAt: number;
  position: { x: number; y: number };
  size: { width: number; height: number };
}

export interface WorkspacesViewWorkspace {
  index: number;
  windowCount: number;
  active: boolean;
  windows: WorkspacesViewWindow[];
}

export interface WorkspacesViewMonitor {
  name: string;
  active: number;
  workspaces: WorkspacesViewWorkspace[];
  rect: ManagedWindowRect | null;
}

export interface WorkspacesView {
  currentMonitor: string;
  monitors: WorkspacesViewMonitor[];
}

// =======================
// WORKSPACE GESTURE TYPES
// =======================
export interface WorkspaceGestureState {
  monitor: string;
  currentIndex: number;
  direction: -1 | 1;
  distance: number;
  fromWorkspace: Workspace;
  toWorkspace: Workspace | null;
  fromOffsetY: number;
  toOffsetY: number;
  fromOpacity: number;
  toOpacity: number;
}

export type WorkspaceGestureMode = "workspace-switch" | "workspace-scroll";

export interface WorkspaceGestureSpeedConfig {
  workspaceScrollFactor?: number;
  // Defaults to workspaceScrollFactor when omitted.
  workspaceScrollKineticFactor?: number;
  workspaceSwitchFactor?: number;
  // Defaults to workspaceSwitchFactor when omitted.
  workspaceSwitchVelocityFactor?: number;
}

interface ResolvedWorkspaceGestureSpeedConfig {
  workspaceScrollFactor: number;
  workspaceScrollKineticFactor: number;
  workspaceSwitchFactor: number;
  workspaceSwitchVelocityFactor: number;
}

export const DEFAULT_WORKSPACE_GESTURE_SPEED: ResolvedWorkspaceGestureSpeedConfig = {
  workspaceScrollFactor: 1,
  workspaceScrollKineticFactor: 1,
  workspaceSwitchFactor: 1,
  workspaceSwitchVelocityFactor: 1,
};

// =================
// DECORATION SIZING
// =================
export const WINDOW_BORDER_PX = 5;
export const TITLEBAR_HEIGHT = 30;
export const MONOCLE_WINDOW_PADDING = {
  top: TILE_GAP,
  right: TILE_GAP,
  bottom: TILE_GAP,
  left: TILE_GAP,
};

// =================
// SNAP ZONE HELPERS
// =================
export type LayoutSnapZone = Exclude<SnapZone, "monocle">;
type SnapColumn = "left" | "right";

export function isLayoutSnapZone(zone: SnapZone | null): zone is LayoutSnapZone {
  return zone !== null && zone !== "monocle";
}

export function isLeftSnapZone(zone: LayoutSnapZone): boolean {
  return zone === "left" || zone === "top-left" || zone === "bottom-left";
}

export function isRightSnapZone(zone: LayoutSnapZone): boolean {
  return zone === "right" || zone === "top-right" || zone === "bottom-right";
}

export function isTopSnapZone(zone: LayoutSnapZone): boolean {
  return zone === "top-left" || zone === "top-right";
}

export function isBottomSnapZone(zone: LayoutSnapZone): boolean {
  return zone === "bottom-left" || zone === "bottom-right";
}

export function snapColumn(zone: LayoutSnapZone): SnapColumn {
  return isLeftSnapZone(zone) ? "left" : "right";
}

export function snapZonesConflict(
  current: SnapZone | null,
  next: LayoutSnapZone,
): boolean {
  if (!isLayoutSnapZone(current)) {
    return false;
  }
  if (current === next) {
    return true;
  }

  if (next === "left") {
    return current === "top-left" || current === "bottom-left";
  }
  if (next === "right") {
    return current === "top-right" || current === "bottom-right";
  }
  if (current === "left") {
    return next === "top-left" || next === "bottom-left";
  }
  if (current === "right") {
    return next === "top-right" || next === "bottom-right";
  }
  return false;
}

// =============================
// WINDOW & WORKSPACE ANIMATIONS
// =============================
const OPEN_ANIMATION_CHANNEL = "window.open";
const CLOSE_ANIMATION_CHANNEL = "window.close";
const MINIMIZE_ANIMATION_CHANNEL = "window.minimize";
const WORKSPACE_VISUAL_ANIMATION_CHANNEL = "workspace.visual";
const WORKSPACE_VISUAL_RECT_ANIMATION_CHANNEL = `${WORKSPACE_VISUAL_ANIMATION_CHANNEL}.rect`;
const WORKSPACE_VISUAL_OPACITY_ANIMATION_CHANNEL = `${WORKSPACE_VISUAL_ANIMATION_CHANNEL}.opacity`;
// Rect deltas use `add` to layer atop override-mode layout animation.

export function scheduleOpenAnimation(window: WaylandWindow): void {
  window.scheduleAnimation({
    channel: OPEN_ANIMATION_CHANNEL,
    rect: {
      from: { x: 0, y: 200, width: 0, height: 0 },
      to: { x: 0, y: 0, width: 0, height: 0 },
      duration: OPEN_CLOSE_ANIMATION_DURATION,
      easing: WINDOW_OPEN_EASING,
      mode: "add",
    },
    opacity: {
      from: 0,
      to: 1,
      duration: OPEN_CLOSE_ANIMATION_DURATION,
      easing: WINDOW_OPEN_EASING,
      mode: "multiply",
    },
  });
}

export function scheduleCloseAnimation(window: WaylandWindow): void {
  window.scheduleAnimation({
    channel: CLOSE_ANIMATION_CHANNEL,
    rect: {
      from: { x: 0, y: 0, width: 0, height: 0 },
      to: { x: 0, y: 120, width: 0, height: 0 },
      duration: OPEN_CLOSE_ANIMATION_DURATION,
      easing: WINDOW_CLOSE_EASING,
      mode: "add",
    },
    opacity: {
      from: 1,
      to: 0,
      duration: OPEN_CLOSE_ANIMATION_DURATION,
      easing: WINDOW_CLOSE_EASING,
      mode: "multiply",
    },
  });
}

export function scheduleMinimizeAnimation(
  window: WaylandWindow,
  minimized: boolean,
): void {
  window.scheduleAnimation({
    channel: MINIMIZE_ANIMATION_CHANNEL,
    rect: {
      from: minimized
        ? { x: 0, y: 0, width: 0, height: 0 }
        : { x: 0, y: 200, width: 0, height: 0 },
      to: minimized
        ? { x: 0, y: 120, width: 0, height: 0 }
        : { x: 0, y: 0, width: 0, height: 0 },
      duration: OPEN_CLOSE_ANIMATION_DURATION,
      easing: minimized
        ? WINDOW_MINIMIZE_RECT_EASING
        : WINDOW_UNMINIMIZE_RECT_EASING,
      mode: "add",
    },
    opacity: {
      from: minimized ? 1 : 0,
      to: minimized ? 0 : 1,
      duration: OPEN_CLOSE_ANIMATION_DURATION,
      easing: minimized
        ? WINDOW_MINIMIZE_OPACITY_EASING
        : WINDOW_UNMINIMIZE_OPACITY_EASING,
      mode: "override",
    },
  });
}

export function scheduleWorkspaceVisualAnimation(
  window: WaylandWindow,
  fromOffsetY: number,
  toOffsetY: number,
  fromOpacity: number,
  toOpacity: number,
  easing: EasingFunction,
  duration: number,
): void {
  cancelWorkspaceVisualAnimation(window);
  window.state[WINDOW_STATE_WORKSPACE_OFFSET_Y].set(0);
  window.state[WINDOW_STATE_WORKSPACE_OPACITY].set(toOpacity);

  window.scheduleAnimation({
    channel: WORKSPACE_VISUAL_RECT_ANIMATION_CHANNEL,
    rect: {
      from: { x: 0, y: fromOffsetY, width: 0, height: 0 },
      to: { x: 0, y: toOffsetY, width: 0, height: 0 },
      duration,
      easing,
      mode: "add",
    },
  });
  window.scheduleAnimation({
    channel: WORKSPACE_VISUAL_OPACITY_ANIMATION_CHANNEL,
    opacity: {
      from: fromOpacity,
      to: toOpacity,
      duration,
      easing,
      mode: "override",
    },
  });
}

export function resetWorkspaceVisualState(
  window: WaylandWindow,
  visible: boolean,
): void {
  cancelWorkspaceVisualAnimation(window);
  window.state[WINDOW_STATE_WORKSPACE_VISIBLE].set(visible);
  window.state[WINDOW_STATE_WORKSPACE_OFFSET_Y].set(0);
  window.state[WINDOW_STATE_WORKSPACE_OPACITY].set(visible ? 1 : 0);
}

export function cancelWorkspaceVisualAnimation(window: WaylandWindow): void {
  window.cancelAnimation(WORKSPACE_VISUAL_ANIMATION_CHANNEL);
  window.cancelAnimation(WORKSPACE_VISUAL_RECT_ANIMATION_CHANNEL);
  window.cancelAnimation(WORKSPACE_VISUAL_OPACITY_ANIMATION_CHANNEL);
}

// =========
// WORKSPACE
// =========
interface LayoutOptions {
  suppressSSDRebuild?: boolean;
  animate?: boolean;
  preserveMissingActive?: boolean;
  cancelRectAnimations?: boolean;
  // Snaps this window straight to its slot instead of growing into it, so
  // scheduleOpenAnimation's swipe+fade is the only visible open transition.
  newWindowId?: string;
}
export class Workspace {
  public index: number;
  private readonly windows: WaylandWindow[] = [];
  private readonly naturalRootRect: (
    window: WaylandWindow,
  ) => ManagedWindowRect;
  private readonly monocleRootRect: (
    window: WaylandWindow,
  ) => ManagedWindowRect;
  private readonly activeWorkspaceIndex: (monitor: string) => number;
  private readonly defaultMaxColumns: (monitor: string) => number;
  private readonly restoredWindowStateById = new Map<
    string,
    WorkspaceWindowSnapshot
  >();
  private activeWindowId: string | null = null;
  private visibilityAnimationToken = 0;
  private draggingWindowId: string | null = null;
  // Captured during applyLayout so the bar can preview where it will land.
  private lastDraggingSlotRect: ManagedWindowRect | null = null;
  private lastAppliedTileViewportRect: ManagedWindowRect | null = null;
  private scrollOffset = 0;
  private kineticScrollPoll: PollHandle | null = null;
  private kineticScrollToken = 0;
  private columnOverride: number | null = null;
  private strictColumns = false;
  public monitor: string;

  public constructor(
    index: number,
    monitor: string,
    naturalRootRect: (window: WaylandWindow) => ManagedWindowRect,
    monocleRootRect: (window: WaylandWindow) => ManagedWindowRect,
    activeWorkspaceIndex: (monitor: string) => number,
    defaultMaxColumns: (monitor: string) => number,
  ) {
    this.index = index;
    this.monitor = monitor;
    this.naturalRootRect = naturalRootRect;
    this.monocleRootRect = monocleRootRect;
    this.activeWorkspaceIndex = activeWorkspaceIndex;
    this.defaultMaxColumns = defaultMaxColumns;
  }

  // ==========
  // MEMBERSHIP
  // ==========
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
    const isTileableInCurrentMode = this.shouldTile(window);
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
    }
    const visible = this.isActive();
    window.state[WINDOW_STATE_WORKSPACE_VISIBLE].set(visible);
    window.state[WINDOW_STATE_WORKSPACE_OFFSET_Y].set(0);
    window.state[WINDOW_STATE_WORKSPACE_OPACITY].set(visible ? 1 : 0);
    this.syncWindowVisibleOutputs(window);

    if (!COMPOSITOR.output.list.includes(this.monitor)) {
      return restored !== undefined;
    }

    if (this.shouldTile(window)) {
      const initialRect = this.centeredFloatingRect(window);
      window.state[WINDOW_STATE_FLOATING_RECT].set(
        restored?.floatingRect ?? initialRect,
      );
      this.scrollToWindow(window);
      this.applyLayout({
        suppressSSDRebuild: false,
        animate: restored === undefined,
        preserveMissingActive: restored !== undefined,
        newWindowId: restored === undefined ? window.id : undefined,
      });
    } else {
      const initialRect = this.centeredFloatingRect(window);
      const contentRect =
        restored?.floatingRect ??
        this.viewportRectToFloatingContentRect(initialRect);
      window.state[WINDOW_STATE_FLOATING_RECT].set(contentRect);
      window.state[WINDOW_STATE_RECT].set(
        this.floatingContentRectToViewportRect(contentRect),
      );
    }
    hotReloadDebug("workspace-add-window", {
      monitor: this.monitor,
      index: this.index,
      windowId: window.id,
      restored: restored !== undefined,
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

  // Returns a copy — safe to mutate without affecting workspace state.
  public listWindows(): WaylandWindow[] {
    return this.windows.slice();
  }

  public findWindowById(windowId: string): WaylandWindow | undefined {
    return this.windows.find((window) => window.id === windowId);
  }

  public isActiveWindowId(windowId: string): boolean {
    return this.activeWindowId === windowId;
  }

  public takeWindowForMove(
    window: WaylandWindow,
  ): { window: WaylandWindow; snapshot: WorkspaceWindowSnapshot } | null {
    if (!this.hasWindow(window)) {
      return null;
    }

    const snapshot = this.snapshotWindow(window);
    // Monocle is a momentary, explicit toggle (config.md) — it must not
    // survive a move to another workspace, and isn't part of the snapshot.
    window.state[WINDOW_STATE_MONOCLE].set(false);
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

  public getWindows(): WaylandWindow[] {
    return Array.from(this.windows);
  }

  // =====
  // FOCUS
  // =====
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

  // Unlike scrollToWindow, force-centers even if already visible ("go to").
  public panToWindow(window: WaylandWindow) {
    if (!this.shouldTile(window)) {
      return;
    }
    this.activeWindowId = window.id;
    this.scrollToWindow(window, { force: true });
    this.applyLayout();
  }

  public focusWindowUnderPointer(window: WaylandWindow): WaylandWindow | undefined {
    if (
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

  public focusedWindow(): WaylandWindow | undefined {
    return this.windows.find((window) => read(window.isFocused));
  }

  private activeWindow(windows = this.windows): WaylandWindow | undefined {
    return windows.find((window) => window.id === this.activeWindowId);
  }

  // ===============
  // LAYOUT & TILING
  // ===============
  public moveFocusedTile(direction: -1 | 1): boolean {
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

  public refreshUsableAreaLayout() {
    if (!COMPOSITOR.output.list.includes(this.monitor)) {
      return;
    }

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
  }

  public applyLayout(options: LayoutOptions = {}) {
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
    const viewportWidth = read(viewportRect.width);
    const contentWidth = this.tileContentWidth(tileable, viewportRect);
    // Ports Hyprland's scrollumns layout.lua `center_shift` — strict mode can
    // pad visibleCols past the actual window count, leaving the row narrower
    // than the viewport; center it instead of leaving it flush left.
    const centerShift =
      contentWidth < viewportWidth ? (viewportWidth - contentWidth) / 2 : 0;
    let nextX = read(viewportRect.x) - this.scrollOffset + centerShift;
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
        : window.state[WINDOW_STATE_MONOCLE]()
          ? this.monocleTileRect(window, nextX)
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
        if (animate && window.id !== options.newWindowId) {
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

  private reapplyStaticManagedLayout(): void {
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

  public shouldTile(window: WaylandWindow): boolean {
    return (
      window.isResizable() &&
      !window.isTransient() &&
      !window.state[WINDOW_STATE_MANUAL_FLOAT]()
    );
  }

  private canSuppressLayoutSSDRebuild(_tileable: WaylandWindow[]): boolean {
    // Suppression is global, so it'd also hide opening windows' decoration.
    return true;
  }

  private tileableWindows(): WaylandWindow[] {
    return this.windows.filter(
      (window) =>
        this.shouldTile(window) && !window.state[WINDOW_STATE_MINIMIZED](),
    );
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

  private tileWidthForWindow(
    window: WaylandWindow,
    viewportRect: ManagedWindowRect,
    tileCount: number,
  ): number {
    if (window.state[WINDOW_STATE_MONOCLE]()) {
      return read(this.monocleRootRect(window).width);
    }

    const maxColumns = this.effectiveMaxColumns();
    const visibleCols = this.strictColumns
      ? maxColumns
      : Math.max(1, Math.min(tileCount, maxColumns));
    const colWidth =
      (read(viewportRect.width) - (visibleCols - 1) * TILE_GAP) / visibleCols;
    const minWidth = this.minTileWidth(window, viewportRect);
    return clamp(
      colWidth,
      minWidth,
      Math.max(minWidth, this.maxTileWidth(window)),
    );
  }

  private effectiveMaxColumns(): number {
    return this.columnOverride ?? this.defaultMaxColumns(this.monitor);
  }

  // Ports Hyprland's scrollumns layout.lua M.bump/toggle_strict/reset —
  // per-workspace column count + strict-padding override, same [1,6] clamp.
  public bumpColumns(delta: number): number {
    this.columnOverride = clamp(
      this.effectiveMaxColumns() + delta,
      TILE_COLUMNS_MIN,
      TILE_COLUMNS_MAX,
    );
    this.applyLayout();
    return this.columnOverride;
  }

  public toggleStrictColumns(): boolean {
    this.strictColumns = !this.strictColumns;
    this.applyLayout();
    return this.strictColumns;
  }

  public resetLayout(): void {
    this.columnOverride = null;
    this.strictColumns = false;
    for (const window of this.windows) {
      window.state[WINDOW_STATE_MONOCLE].set(false);
    }
    this.applyLayout();
  }

  private monocleTileRect(
    window: WaylandWindow,
    x: number,
  ): ManagedWindowRect {
    const monocleRect = this.monocleRootRect(window);
    return {
      x,
      y: read(monocleRect.y),
      width: read(monocleRect.width),
      height: read(monocleRect.height),
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

  // ========
  // FLOATING
  // ========
  public adoptFloatingWindow(window: WaylandWindow, rect: ManagedWindowRect) {
    if (!this.hasWindow(window)) {
      this.windows.push(window);
    }
    const visible = this.isActive();
    this.activeWindowId = window.id;
    this.syncWindowVisibleOutputs(window);
    resetWorkspaceVisualState(window, visible);
    window.state[WINDOW_STATE_FLOATING_RECT].set(
      this.viewportRectToFloatingContentRect(rect),
    );
    stopRectAnimation(window, WINDOW_STATE_RECT);
    window.state[WINDOW_STATE_RECT].set(rect);
  }

  public syncFloatingWindowRect(
    window: WaylandWindow,
    viewportRect: ManagedWindowRect,
  ) {
    if (this.shouldTile(window)) {
      return;
    }
    window.state[WINDOW_STATE_FLOATING_RECT].set(
      this.viewportRectToFloatingContentRect(viewportRect),
    );
  }

  private captureFloatingRect(window: WaylandWindow) {
    if (!window.state[WINDOW_STATE_FLOATING_RECT]()) {
      const rect = this.viewportRectToFloatingContentRect(
        window.state[WINDOW_STATE_RECT](),
      );
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
      // Same degenerate-rect risk as setTiled(false) — skip monocle windows.
      if (window.state[WINDOW_STATE_MONOCLE]()) {
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
    // Just-committed clients report ≈0 size — fall back, don't freeze it in.
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

  // =========
  // TILE DRAG
  // =========
  public draggingSlotRect(): ManagedWindowRect | null {
    return this.draggingWindowId ? this.lastDraggingSlotRect : null;
  }

  public beginTileDrag(window: WaylandWindow, rect: ManagedWindowRect) {
    if (!this.shouldTile(window)) {
      return;
    }
    this.activeWindowId = window.id;
    this.draggingWindowId = window.id;
    const wasMonocle = window.state[WINDOW_STATE_MONOCLE]();
    window.state[WINDOW_STATE_MONOCLE].set(false);
    window.state[WINDOW_STATE_RESTORE_RECT].set(null);
    if (wasMonocle) {
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

  // ======
  // SCROLL
  // ======
  public scrollBy(
    deltaX: number,
    options: {
      stopKinetic?: boolean;
      suppressSSDRebuild?: boolean;
      cancelRectAnimations?: boolean;
    } = {},
  ): boolean {
    if (deltaX === 0) {
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
    if (Math.abs(initialVelocityX) < WORKSPACE_KINETIC_SCROLL_MIN_VELOCITY) {
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
        if (this.kineticScrollToken !== token) {
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

    if (window.state[WINDOW_STATE_MONOCLE]() || options.force) {
      // `force` (dock "go to") always pans, even if already on-screen.
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

  // ========================
  // VISIBILITY & TRANSITIONS
  // ========================
  public isActive(): boolean {
    return this.activeWorkspaceIndex(this.monitor) === this.index;
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
      // Schedule before flipping VISIBLE — matches prepare's ordering.
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

  private syncWindowVisibleOutputs(window: WaylandWindow) {
    window.state[WINDOW_STATE_TILED].set(this.shouldTile(window));
    window.state[WINDOW_STATE_VISIBLE_OUTPUTS].set([this.monitor]);
  }

  // ===========
  // PERSISTENCE
  // ===========
  public snapshot(): WorkspaceSnapshot {
    return {
      monitor: this.monitor,
      index: this.index,
      activeWindowId: this.activeWindowId,
      scrollOffset: this.scrollOffset,
      windows: this.windows.map((window) => this.snapshotWindow(window)),
    };
  }

  public restore(snapshot: WorkspaceSnapshot) {
    this.activeWindowId = snapshot.activeWindowId;
    this.scrollOffset = snapshot.scrollOffset;
    this.restoredWindowStateById.clear();
    for (const window of snapshot.windows) {
      this.restoredWindowStateById.set(window.id, window);
    }
    hotReloadDebug("workspace-restore", {
      monitor: this.monitor,
      index: this.index,
      activeWindowId: this.activeWindowId,
      scrollOffset: this.scrollOffset,
      restoredWindowIds: Array.from(this.restoredWindowStateById.keys()),
    });
  }

  private snapshotWindow(window: WaylandWindow): WorkspaceWindowSnapshot {
    return {
      id: window.id,
      floatingRect: window.state[WINDOW_STATE_FLOATING_RECT](),
      restoreRect: window.state[WINDOW_STATE_RESTORE_RECT](),
      snapZone: window.state[WINDOW_STATE_SNAP_ZONE](),
      snapMonitor: window.state[WINDOW_STATE_SNAP_MONITOR](),
      minimized: window.state[WINDOW_STATE_MINIMIZED](),
    };
  }

}

// =====================
// HYBRID WINDOW MANAGER
// =====================
function sanitizeGestureSpeedFactor(
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return value;
}
export class HybridWindowManager {
  private readonly workspaces = new Map<string, Workspace>();
  private readonly activeWorkspaceByMonitor = new Map<string, number>();
  private readonly windowStack = createWindowStack();
  private readonly naturalRootRect: (rect: WaylandWindow) => ManagedWindowRect;
  // Per-monitor default column count, ports Hyprland's layout.lua
  // resolve_max_cols (devices/*.lua's `L.register({ [name] = cols })`).
  // Falls back to TILE_MAX_COLUMNS for any monitor not listed.
  private readonly columnsByMonitor: Record<string, number>;
  // Lets the dock pick the most-recently-used window of an app.
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
  private monocleMoveDrag: {
    windowId: string;
    width: number;
    height: number;
  } | null = null;
  private workspaceGesture: WorkspaceGestureState | null = null;
  private workspaceGestureMode: WorkspaceGestureMode | null = null;
  private workspaceScrollGestureRectAnimationsCancelled = false;
  private workspaceGestureSpeed = { ...DEFAULT_WORKSPACE_GESTURE_SPEED };
  private lastPointerPosition: PointerMoveEvent["position"] | null = null;
  private lastPointerTarget: PointerMoveEvent["target"] = { kind: "none" };
  private snapPreviewBroadcaster: SnapPreviewBroadcaster | null = null;
  private workspaceChangeBroadcaster: WorkspaceChangeBroadcaster | null = null;
  private floatingSnap: {
    windowId: string;
    monitor: string;
    zone: SnapZone;
    rect: ManagedWindowRect;
  } | null = null;

  public constructor(
    naturalRootRect: (rect: WaylandWindow) => ManagedWindowRect,
    columnsByMonitor: Record<string, number> = {},
  ) {
    this.currentMonitor = "";
    this.naturalRootRect = naturalRootRect;
    this.columnsByMonitor = columnsByMonitor;
    this.syncWorkspaces();
  }

  private defaultMaxColumnsForMonitor(monitor: string): number {
    return this.columnsByMonitor[monitor] ?? TILE_MAX_COLUMNS;
  }

  // ======
  // CONFIG
  // ======
  public configureWorkspaceGestureSpeed(
    config: WorkspaceGestureSpeedConfig,
  ): void {
    const workspaceScrollFactor = sanitizeGestureSpeedFactor(
      config.workspaceScrollFactor,
      DEFAULT_WORKSPACE_GESTURE_SPEED.workspaceScrollFactor,
    );
    const workspaceSwitchFactor = sanitizeGestureSpeedFactor(
      config.workspaceSwitchFactor,
      DEFAULT_WORKSPACE_GESTURE_SPEED.workspaceSwitchFactor,
    );
    this.workspaceGestureSpeed = {
      workspaceScrollFactor,
      workspaceScrollKineticFactor: sanitizeGestureSpeedFactor(
        config.workspaceScrollKineticFactor,
        workspaceScrollFactor,
      ),
      workspaceSwitchFactor,
      workspaceSwitchVelocityFactor: sanitizeGestureSpeedFactor(
        config.workspaceSwitchVelocityFactor,
        workspaceSwitchFactor,
      ),
    };
  }

  // ================
  // WINDOW LIFECYCLE
  // ================
  public onOpen(window: WaylandWindow) {
    window.focus();
    this.windowStack.add(window);

    window.setCloseAnimationDuration(OPEN_CLOSE_ANIMATION_DURATION);
  }

  public onFirstCommit(window: WaylandWindow) {
    if (!this.windowStack.has(window)) {
      this.windowStack.add(window, { at: "back" });
    }
    window.setCloseAnimationDuration(OPEN_CLOSE_ANIMATION_DURATION);

    let restoredExistingWindow = false;
    const workspace =
      this.findWorkspaceRestoringWindow(window) ?? this.getCurrentWorkspace();
    const willTile = Boolean(workspace?.shouldTile(window));
    if (workspace) {
      restoredExistingWindow = workspace.addWindow(window);
      if (!restoredExistingWindow && willTile) {
        this.trackPendingInitialFocus(window);
      }
      this.applyWorkspaceStackPolicy(workspace);
      this.syncWorkspaceVisibility();
    } else {
      window.state[WINDOW_STATE_RECT].set(this.naturalRootRect(window));
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
    // Without this, a window reusing a freed id inherits stale state.
    dropWindowState(window.id);
  }

  public onFocus(window: WaylandWindow, focused: boolean) {
    if (focused) {
      window.state[WINDOW_STATE_URGENT].set(false);
      this.windowStack.raise(window);
      const workspace = this.findWorkspaceForWindow(window);
      if (this.shouldDeferFocusLayoutForInitialOpen(window, workspace)) {
        this.applyWorkspaceStackPolicy(workspace);
        return;
      }
      if (workspace?.isActive()) {
        workspace.focusWindow(window);
        this.applyWorkspaceStackPolicy(workspace);
      }
    }
  }

  // ===========
  // PERSISTENCE
  // ===========
  public snapshot(): HybridWindowManagerSnapshot {
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
        activeWindowId: workspace.activeWindowId,
        windowIds: workspace.windows.map((window) => window.id),
      })),
    });
    return snapshot;
  }

  public restore(snapshot: HybridWindowManagerSnapshot) {
    hotReloadDebug("hybrid-restore", {
      currentMonitor: snapshot.currentMonitor,
      workspaceCount: snapshot.workspaces.length,
      workspaces: snapshot.workspaces.map((workspace) => ({
        monitor: workspace.monitor,
        index: workspace.index,
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

  // =============
  // RESIZE & MOVE
  // =============
  public onWindowResize(event: WindowResizeEvent) {
    if (!read(event.window.isResizable)) {
      return;
    }

    const workspace = this.findWorkspaceForWindow(event.window);
    if (event.phase === "start" || event.phase === "update") {
      this.beginInteractiveExitMonocle(event.window);
    }

    if (workspace?.shouldTile(event.window)) {
      // Tiled windows have fixed column widths — resize requests are a no-op.
      return;
    }

    const nextRect = this.constrainResizeRect(event);
    stopRectAnimation(event.window, WINDOW_STATE_RECT);
    event.window.state[WINDOW_STATE_RECT].set(nextRect);
    workspace?.syncFloatingWindowRect(event.window, nextRect);
    this.applyWorkspaceStackPolicy(workspace);
  }

  public onWindowMove(event: WindowMoveEvent) {
    const workspace = this.findWorkspaceForWindow(event.window);
    if (workspace?.shouldTile(event.window)) {
      this.onTileWindowMove(event, workspace);
      this.applyWorkspaceStackPolicy(workspace);
      return;
    }

    if (workspace) {
      this.onFloatingWindowMove(event, workspace);
      return;
    }

    const window = event.window;
    if (event.phase === "start" && window.state[WINDOW_STATE_MONOCLE]()) {
      const restoreRect =
        window.state[WINDOW_STATE_RESTORE_RECT]() ?? event.currentRect;
      this.monocleMoveDrag = {
        windowId: window.id,
        width: read(restoreRect.width),
        height: read(restoreRect.height),
      };
      this.beginInteractiveExitMonocle(window);
    }
    if (event.phase === "start") {
      this.isGrabbing = true;
      this.clearWindowSnapState(window);
    }

    const monocleMoveDrag =
      this.monocleMoveDrag?.windowId === window.id
        ? this.monocleMoveDrag
        : null;
    if (monocleMoveDrag) {
      const nextRect = this.restoreRectForMonocleMove(
        event,
        monocleMoveDrag.width,
        monocleMoveDrag.height,
      );
      if (event.phase === "start") {
        playRectAnimation(
          window,
          WINDOW_STATE_RECT,
          nextRect,
          WINDOW_MANAGEMENT_EASING,
          MONOCLE_EXIT_GRAB_ANIMATION_DURATION,
        );
      } else {
        stopRectAnimation(window, WINDOW_STATE_RECT);
        window.state[WINDOW_STATE_RECT].set(nextRect);
      }
      if (event.phase === "end") {
        this.isGrabbing = false;
        this.monocleMoveDrag = null;
        this.finishFloatingDragSnap(event, workspace);
      } else if (event.phase === "cancel") {
        this.isGrabbing = false;
        this.monocleMoveDrag = null;
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
      if (window.state[WINDOW_STATE_MONOCLE]()) {
        const restoreRect =
          window.state[WINDOW_STATE_RESTORE_RECT]() ?? event.currentRect;
        this.monocleMoveDrag = {
          windowId: window.id,
          width: read(restoreRect.width),
          height: read(restoreRect.height),
        };
        this.beginInteractiveExitMonocle(window);
      }
      this.clearWindowSnapState(window);
    }

    const drag = this.floatingDrag;
    if (!drag) {
      return;
    }

    const monocleMoveDrag =
      this.monocleMoveDrag?.windowId === window.id
        ? this.monocleMoveDrag
        : null;
    const nextRect: ManagedWindowRect = monocleMoveDrag
      ? this.restoreRectForMonocleMove(
          event,
          monocleMoveDrag.width,
          monocleMoveDrag.height,
        )
      : event.currentRect;

    if (monocleMoveDrag && event.phase === "start") {
      playRectAnimation(
        window,
        WINDOW_STATE_RECT,
        nextRect,
        WINDOW_MANAGEMENT_EASING,
        MONOCLE_EXIT_GRAB_ANIMATION_DURATION,
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
        if (targetWorkspace.shouldTile(window)) {
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
            this.monocleMoveDrag = null;
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
      if (monocleMoveDrag) {
        this.monocleMoveDrag = null;
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
      if (!targetWorkspace.shouldTile(window)) {
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

  // ==========================================
  // MAXIMIZE / MINIMIZE / FULLSCREEN / MONOCLE
  // ==========================================
  public onWindowMaximizeRequest(event: WindowMaximizeRequestEvent) {
    // Monocle only enters via Super+F (toggleFocusedWindowMonocle calls
    // window.maximize(), source "api"). Every other source — client CSD
    // buttons, xwayland _NET_WM_STATE_MAXIMIZED, clients replaying their
    // own "was maximized" state on launch (Zen/Firefox does this) — is
    // ignored, so nothing but the keybind can put a window into monocle.
    if (event.maximized && event.source !== "api") {
      return;
    }

    const workspace = this.findWorkspaceForWindow(event.window);
    if (this.isGrabbing) {
      return;
    }

    const window = event.window;
    window.state[WINDOW_STATE_MINIMIZED].set(false);
    this.clearWindowSnapState(window);

    if (workspace?.shouldTile(window)) {
      if (!event.maximized) {
        window.state[WINDOW_STATE_RESTORE_RECT].set(null);
        window.state[WINDOW_STATE_MONOCLE].set(false);
        workspace.applyLayout();
        this.applyWorkspaceStackPolicy(workspace);
        return;
      }

      window.state[WINDOW_STATE_RESTORE_RECT].set(null);
      window.state[WINDOW_STATE_MONOCLE].set(true);
      workspace.panToWindow(window);
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
      window.state[WINDOW_STATE_MONOCLE].set(false);
      return;
    }

    if (!window.state[WINDOW_STATE_MONOCLE]()) {
      const currentRect = window.state[WINDOW_STATE_RECT]();
      const currentWidth = read(currentRect.width);
      const currentHeight = read(currentRect.height);
      if (currentWidth > 1 && currentHeight > 1) {
        window.state[WINDOW_STATE_RESTORE_RECT].set(currentRect);
      }
    }
    const monocleRect = this.monocleRectForWindow(window);
    workspace?.syncFloatingWindowRect(window, monocleRect);
    playRectAnimation(
      window,
      WINDOW_STATE_RECT,
      monocleRect,
      WINDOW_MANAGEMENT_EASING,
      WINDOW_MANAGEMENT_ANIMATION_DURATION,
    );
    window.state[WINDOW_STATE_MONOCLE].set(true);
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
    if (workspace) {
      if (!event.minimized && workspace.shouldTile(event.window)) {
        workspace.focusWindow(event.window);
      } else {
        workspace.applyLayout();
      }
      this.applyWorkspaceStackPolicy(workspace);
    }
  }

  public toggleFocusedWindowMonocle() {
    for (const workspace of this.workspaces.values()) {
      const focused = workspace.focusedWindow();
      if (!focused || !read(focused.isResizable)) {
        continue;
      }

      if (focused.state[WINDOW_STATE_MONOCLE]()) {
        focused.unmaximize();
      } else {
        focused.maximize();
      }
      return;
    }
  }

  public toggleFocusedWindowFullscreen() {
    for (const workspace of this.workspaces.values()) {
      const focused = workspace.focusedWindow();
      if (!focused) {
        continue;
      }

      if (focused.state[WINDOW_STATE_FULLSCREEN]()) {
        focused.unfullscreen();
      } else {
        focused.fullscreen();
      }
      return;
    }
  }

  public bumpColumns(delta: number): { index: number; columns: number } | null {
    const workspace = this.workspaceForMonitor(this.currentMonitor);
    if (!workspace) {
      return null;
    }
    return { index: workspace.index, columns: workspace.bumpColumns(delta) };
  }

  public toggleStrictColumns(): { index: number; strict: boolean } | null {
    const workspace = this.workspaceForMonitor(this.currentMonitor);
    if (!workspace) {
      return null;
    }
    return { index: workspace.index, strict: workspace.toggleStrictColumns() };
  }

  public resetWorkspaceLayout(): { index: number } | null {
    const workspace = this.workspaceForMonitor(this.currentMonitor);
    if (!workspace) {
      return null;
    }
    workspace.resetLayout();
    return { index: workspace.index };
  }

  private beginInteractiveExitMonocle(window: WaylandWindow): boolean {
    if (!window.state[WINDOW_STATE_MONOCLE]()) {
      return false;
    }

    window.state[WINDOW_STATE_MONOCLE].set(false);
    window.state[WINDOW_STATE_RESTORE_RECT].set(null);
    this.clearWindowSnapState(window);
    window.unmaximize();
    return true;
  }

  private monocleRectForWindow(
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
        MONOCLE_WINDOW_PADDING,
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
        MONOCLE_WINDOW_PADDING,
      );
    }
    return rect;
  }

  // Ignores usable-area insets (unlike maximize) so tty can scanout it.
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
      if (workspace?.shouldTile(window)) {
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

  private restoreRectForMonocleMove(
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

  // ==================
  // FOCUS & TILE ORDER
  // ==================
  public onWindowActivateRequest(event: WindowActivateRequestEvent) {
    const workspaceForUrgency = this.findWorkspaceForWindow(event.window);
    if (
      event.source === "xdg-activation" &&
      !event.window.isFocused() &&
      !(workspaceForUrgency?.isActive() ?? false)
    ) {
      // A background app asked for attention rather than the user driving
      // this — flag it instead of stealing focus out from under them.
      event.window.state[WINDOW_STATE_URGENT].set(true);
      return;
    }
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
      // Same slide/fade as keyboard/gesture switching; no-op if already active.
      this.switchWorkspaceTo(workspace.monitor, workspace.index, {
        focusActiveAfter: false,
      });
    }
    // Overrides switchWorkspaceTo's focusActiveWindow with the actual target.
    event.window.focus();
  }

  public focusTile(direction: -1 | 1) {
    withManagedWindowOnlySSDRebuildSuppressed(() => {
      const workspace = this.getCurrentWorkspace();
      if (!workspace) {
        return;
      }
      workspace.focusRelative(direction);
      this.applyWorkspaceStackPolicy(workspace);
    });
  }

  public moveFocusedTile(direction: -1 | 1) {
    withManagedWindowOnlySSDRebuildSuppressed(() => {
      const workspace = this.getCurrentWorkspace();
      if (!workspace) {
        return;
      }
      if (!workspace.moveFocusedTile(direction)) {
        return;
      }
      this.applyWorkspaceStackPolicy(workspace);
    });
  }

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
    if (!workspace?.isActive()) {
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

    if (!workspace.isActive()) {
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
    if (!workspace?.isActive()) {
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

  // ==================
  // WORKSPACE MOVEMENT
  // ==================
  private moveFocusedWindowToWorkspaceIndexInternal(
    fromWorkspace: Workspace,
    targetIndex: number,
    follow: boolean,
  ) {
    if (targetIndex === fromWorkspace.index) {
      return;
    }

    const window = fromWorkspace.focusedWindow();
    if (!window) {
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
    if (follow) {
      this.switchWorkspaceTo(fromWorkspace.monitor, targetIndex, {
        focusActiveAfter: false,
      });
    }
    targetWorkspace.panToWindow(window);
    if (follow) {
      window.focus();
    }
    this.applyWorkspaceStackPolicy(fromWorkspace);
    this.applyWorkspaceStackPolicy(targetWorkspace);
    this.syncWorkspaceVisibility();
  }

  public moveFocusedWindowToWorkspaceIndex(
    monitor: string,
    targetIndex: number,
    options?: { follow?: boolean },
  ) {
    const follow = options?.follow ?? true;
    withManagedWindowOnlySSDRebuildSuppressed(() => {
      this.syncWorkspaces();
      const currentIndex = this.activeWorkspaceByMonitor.get(monitor) ?? 1;
      const fromWorkspace = this.ensureWorkspace(monitor, currentIndex);
      this.moveFocusedWindowToWorkspaceIndexInternal(
        fromWorkspace,
        targetIndex,
        follow,
      );
    });
  }

  public adaptiveMoveFocusedWindow(direction: "up" | "down") {
    withManagedWindowOnlySSDRebuildSuppressed(() => {
      this.syncWorkspaces();

      const focused = Array.from(this.workspaces.values())
        .map((workspace) => ({ workspace, window: workspace.focusedWindow() }))
        .find(({ window }) => window !== undefined);
      const window = focused?.window;
      if (!window) {
        return;
      }

      const fromWorkspace = focused.workspace;
      const targetMonitor = this.nearestMonitorInDirection(
        fromWorkspace.monitor,
        direction,
      );
      if (!targetMonitor) {
        return;
      }

      const targetIndex = this.activeWorkspaceByMonitor.get(targetMonitor) ?? 1;
      const targetWorkspace = this.ensureWorkspace(targetMonitor, targetIndex);

      const moved = fromWorkspace.takeWindowForMove(window);
      if (!moved) {
        return;
      }

      targetWorkspace.addMovedWindow(window, moved.snapshot);
      fromWorkspace.applyLayout();
      targetWorkspace.applyLayout();
      this.switchWorkspaceTo(targetMonitor, targetIndex, {
        focusActiveAfter: false,
      });
      targetWorkspace.panToWindow(window);
      window.focus();
      this.applyWorkspaceStackPolicy(fromWorkspace);
      this.applyWorkspaceStackPolicy(targetWorkspace);
      this.syncWorkspaceVisibility();
    });
  }

  private nearestMonitorInDirection(
    monitor: string,
    direction: "up" | "down",
  ): string | null {
    const from = COMPOSITOR.output.get(monitor);
    if (!from?.resolution) {
      return null;
    }
    const fromCx = from.position.x + from.resolution.width / 2;
    const fromCy = from.position.y + from.resolution.height / 2;

    let best: string | null = null;
    let bestDist = Infinity;
    for (const name of COMPOSITOR.output.list) {
      if (name === monitor) {
        continue;
      }
      const info = COMPOSITOR.output.get(name);
      if (!info?.resolution) {
        continue;
      }
      const cx = info.position.x + info.resolution.width / 2;
      const cy = info.position.y + info.resolution.height / 2;
      const dy = cy - fromCy;
      if (direction === "up" ? dy >= 0 : dy <= 0) {
        continue;
      }
      const dx = cx - fromCx;
      const dist = dx * dx + dy * dy;
      if (dist < bestDist) {
        best = name;
        bestDist = dist;
      }
    }
    return best;
  }

  public swapWorkspace(monitor: string, targetIndex: number) {
    withManagedWindowOnlySSDRebuildSuppressed(() => {
      this.syncWorkspaces();
      const currentIndex = this.activeWorkspaceByMonitor.get(monitor) ?? 1;
      if (currentIndex === targetIndex) {
        return;
      }

      const fromWorkspace = this.ensureWorkspace(monitor, currentIndex);
      const toWorkspace = this.ensureWorkspace(monitor, targetIndex);

      const fromWindows = fromWorkspace.allWindows().map((window) => ({
        window,
        taken: fromWorkspace.takeWindowForMove(window)!,
      }));
      const toWindows = toWorkspace.allWindows().map((window) => ({
        window,
        taken: toWorkspace.takeWindowForMove(window)!,
      }));

      for (const { window, taken } of fromWindows) {
        toWorkspace.addMovedWindow(window, taken.snapshot);
      }
      for (const { window, taken } of toWindows) {
        fromWorkspace.addMovedWindow(window, taken.snapshot);
      }

      fromWorkspace.applyLayout();
      toWorkspace.applyLayout();
      this.switchWorkspaceTo(monitor, targetIndex);
      this.applyWorkspaceStackPolicy(fromWorkspace);
      this.applyWorkspaceStackPolicy(toWorkspace);
      this.syncWorkspaceVisibility();
    });
  }

  public moveWorkspaceInto(monitor: string, targetIndex: number) {
    withManagedWindowOnlySSDRebuildSuppressed(() => {
      this.syncWorkspaces();
      const currentIndex = this.activeWorkspaceByMonitor.get(monitor) ?? 1;
      if (currentIndex === targetIndex) {
        return;
      }

      const fromWorkspace = this.ensureWorkspace(monitor, currentIndex);
      const toWorkspace = this.ensureWorkspace(monitor, targetIndex);

      const moved = fromWorkspace.allWindows().map((window) => ({
        window,
        taken: fromWorkspace.takeWindowForMove(window)!,
      }));
      for (const { window, taken } of moved) {
        toWorkspace.addMovedWindow(window, taken.snapshot);
      }

      fromWorkspace.applyLayout();
      toWorkspace.applyLayout();
      this.switchWorkspaceTo(monitor, targetIndex);
      this.applyWorkspaceStackPolicy(fromWorkspace);
      this.applyWorkspaceStackPolicy(toWorkspace);
      this.syncWorkspaceVisibility();
    });
  }

  // ===============
  // WINDOW COMMANDS
  // ===============
  public closeFocusedWindow() {
    for (const workspace of this.workspaces.values()) {
      const focused = workspace.focusedWindow();
      if (focused) {
        focused.close();
        return;
      }
    }
  }

  public closeCurrentWorkspaceWindows() {
    for (const window of this.getCurrentWorkspace()?.listWindows() ?? []) {
      window.close();
    }
  }

  public closeAllWindows() {
    for (const workspace of this.workspaces.values()) {
      for (const window of workspace.listWindows()) {
        window.close();
      }
    }
  }

  public toggleFocusedWindowFloating() {
    for (const workspace of this.workspaces.values()) {
      const focused = workspace.focusedWindow();
      if (!focused || !read(focused.isResizable) || focused.isTransient()) {
        continue;
      }

      focused.state[WINDOW_STATE_MANUAL_FLOAT].set(
        !focused.state[WINDOW_STATE_MANUAL_FLOAT](),
      );
      workspace.applyLayout();
      this.applyWorkspaceStackPolicy(workspace);
      return;
    }
  }

  // ===================
  // WORKSPACE LIFECYCLE
  // ===================
  public refreshUsableAreaLayouts() {
    this.syncWorkspaces();
    // Would clobber an in-flight drag (flashes monocle on layer-surface mount).
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

  // Direction inferred from current index so the usual slide/fade plays.
  public switchWorkspaceTo(
    monitor: string,
    targetIndex: number,
    options: { focusActiveAfter?: boolean } = {},
  ) {
    this.workspaceGesture = null;
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
    // Lets dock activation focus its own target without stomping the pan.
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

  public getCurrentMonitorName(): string {
    this.syncWorkspaces();
    return this.currentMonitor || COMPOSITOR.output.list.at(0) || "";
  }

  public activate(monitor: string, index: number) {
    if (!monitor || index < 1) {
      return;
    }
    this.switchWorkspaceTo(monitor, index);
  }

  private applyWorkspaceStackPolicy(workspace: Workspace | undefined) {
    if (!workspace) {
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
      for (let index = 1; index <= WORKSPACES_PER_MONITOR; index += 1) {
        this.ensureWorkspace(monitor, index);
      }
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
        (window) => this.monocleRectForWindow(window, monitor),
        (monitor) => this.getActiveWorkspaceIndex(monitor),
        (monitor) => this.defaultMaxColumnsForMonitor(monitor),
      );
      this.workspaces.set(key, workspace);
    }
    return workspace;
  }

  private getActiveWorkspaceIndex(monitor: string): number {
    return this.activeWorkspaceByMonitor.get(monitor) ?? 1;
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

  // ========
  // GESTURES
  // ========
  public onGestureSwipe(event: GestureSwipeEvent) {
    if (event.fingers !== WORKSPACE_GESTURE_FINGERS) {
      return;
    }

    this.syncWorkspaces();
    if (event.position) {
      this.lastPointerPosition = event.position;
    }

    if (event.phase === "begin") {
      this.workspaceGesture = null;
      this.workspaceGestureMode = null;
      this.workspaceScrollGestureRectAnimationsCancelled = false;
      this.currentMonitor = this.gestureMonitor(event);
      return;
    }

    if (event.phase === "update") {
      const mode = this.resolveWorkspaceGestureMode(event);
      if (mode === "workspace-scroll") {
        this.workspaceGesture = null;
        this.updateWorkspaceScrollGesture(event);
        return;
      }
      if (mode === "workspace-switch") {
        this.updateWorkspaceGesture(event);
      }
      return;
    }

    if (this.workspaceGestureMode === "workspace-scroll") {
      this.workspaceGestureMode = null;
      this.workspaceGesture = null;
      this.finishWorkspaceScrollGesture(event);
      this.workspaceScrollGestureRectAnimationsCancelled = false;
      this.focusWindowAtPointerPosition(
        event.position ?? this.lastPointerPosition,
        event.outputName,
      );
      return;
    }

    this.workspaceGestureMode = null;
    this.workspaceScrollGestureRectAnimationsCancelled = false;
    this.finishWorkspaceGesture(event);
  }

  private gestureMonitor(event: GestureSwipeEvent): string {
    const outputName = event.outputName;
    if (outputName && COMPOSITOR.output.list.includes(outputName)) {
      return outputName;
    }
    return this.currentMonitor || COMPOSITOR.output.list.at(0) || "";
  }

  private resolveWorkspaceGestureMode(
    event: GestureSwipeEvent,
  ): WorkspaceGestureMode | null {
    if (this.workspaceGestureMode) {
      return this.workspaceGestureMode;
    }

    const absX = Math.abs(event.totalX);
    const absY = Math.abs(
      event.totalY * this.workspaceGestureSpeed.workspaceSwitchFactor,
    );
    const scaledAbsX = absX * this.workspaceGestureSpeed.workspaceScrollFactor;
    if (Math.max(scaledAbsX, absY) < WORKSPACE_GESTURE_AXIS_LOCK_PX) {
      return null;
    }

    this.workspaceGestureMode =
      scaledAbsX > absY ? "workspace-scroll" : "workspace-switch";
    if (this.workspaceGestureMode === "workspace-scroll") {
      this.workspaceScrollGestureRectAnimationsCancelled = false;
    }
    return this.workspaceGestureMode;
  }

  private updateWorkspaceScrollGesture(event: GestureSwipeEvent) {
    const monitor = this.gestureMonitor(event);
    const workspace = this.workspaceForMonitor(monitor);
    if (!workspace) {
      return;
    }

    this.currentMonitor = monitor;
    workspace.stopKineticScroll();
    const deltaX =
      -event.deltaX * this.workspaceGestureSpeed.workspaceScrollFactor;
    const shouldCancelRectAnimations =
      !this.workspaceScrollGestureRectAnimationsCancelled;
    const scrolled = workspace.scrollBy(deltaX, {
      stopKinetic: false,
      cancelRectAnimations: shouldCancelRectAnimations,
    });
    if (scrolled && shouldCancelRectAnimations) {
      this.workspaceScrollGestureRectAnimationsCancelled = true;
    }
    this.focusWindowAtPointerPosition(
      event.position ?? this.lastPointerPosition,
      monitor,
    );
    this.applyWorkspaceStackPolicy(workspace);
  }

  private finishWorkspaceScrollGesture(event: GestureSwipeEvent) {
    if (event.phase !== "end") {
      return;
    }

    const monitor = this.gestureMonitor(event);
    const workspace = this.workspaceForMonitor(monitor);
    if (!workspace) {
      return;
    }

    workspace.startKineticScroll(
      -event.velocityX *
        this.workspaceGestureSpeed.workspaceScrollKineticFactor,
      () => {
        this.focusWindowAtPointerPosition(
          event.position ?? this.lastPointerPosition,
          monitor,
        );
        this.applyWorkspaceStackPolicy(workspace);
      },
    );
  }

  private updateWorkspaceGesture(event: GestureSwipeEvent) {
    const monitor = this.gestureMonitor(event);
    if (!monitor) {
      return;
    }

    const distance = Math.max(1, this.workspaceTransitionDistance(monitor));
    const scaledTotalY =
      event.totalY * this.workspaceGestureSpeed.workspaceSwitchFactor;
    const rawOffsetY = clamp(scaledTotalY, -distance, distance);
    if (Math.abs(rawOffsetY) < 1) {
      return;
    }

    const direction: -1 | 1 = rawOffsetY < 0 ? 1 : -1;
    const currentIndex = this.activeWorkspaceByMonitor.get(monitor) ?? 1;
    const nextIndex = currentIndex + direction;
    const fromWorkspace = this.ensureWorkspace(monitor, currentIndex);
    const toWorkspace =
      nextIndex >= 1 ? this.ensureWorkspace(monitor, nextIndex) : null;
    const targetChanged =
      this.workspaceGesture?.monitor !== monitor ||
      this.workspaceGesture.currentIndex !== currentIndex ||
      this.workspaceGesture.toWorkspace !== toWorkspace;

    this.currentMonitor = monitor;

    if (!toWorkspace) {
      if (targetChanged) {
        for (const workspace of this.workspaces.values()) {
          if (workspace === fromWorkspace) {
            continue;
          }
          workspace.setVisible(workspace.isActive());
        }
      }
      const resistanceOffsetY = rawOffsetY * 0.25;
      fromWorkspace.setWorkspaceGestureVisual(resistanceOffsetY, 1);
      this.workspaceGesture = {
        monitor,
        currentIndex,
        direction,
        distance,
        fromWorkspace,
        toWorkspace: null,
        fromOffsetY: resistanceOffsetY,
        toOffsetY: direction * distance,
        fromOpacity: 1,
        toOpacity: 0,
      };
      return;
    }

    const progress = clamp(Math.abs(rawOffsetY) / distance, 0, 1);
    const toOffsetY = direction * distance + rawOffsetY;
    const fromOpacity = 1 - progress;
    const toOpacity = progress;

    if (targetChanged) {
      for (const workspace of this.workspaces.values()) {
        if (workspace === fromWorkspace || workspace === toWorkspace) {
          continue;
        }
        workspace.setVisible(workspace.isActive());
      }
      toWorkspace.applyLayout();
    }

    fromWorkspace.setWorkspaceGestureVisual(rawOffsetY, fromOpacity);
    toWorkspace.setWorkspaceGestureVisual(toOffsetY, toOpacity);
    this.applyWorkspaceStackPolicy(fromWorkspace);
    this.applyWorkspaceStackPolicy(toWorkspace);

    this.workspaceGesture = {
      monitor,
      currentIndex,
      direction,
      distance,
      fromWorkspace,
      toWorkspace,
      fromOffsetY: rawOffsetY,
      toOffsetY,
      fromOpacity,
      toOpacity,
    };
  }

  private finishWorkspaceGesture(event: GestureSwipeEvent) {
    const gesture = this.workspaceGesture;
    this.workspaceGesture = null;
    if (!gesture) {
      return;
    }

    const shouldCommit =
      event.phase === "end" &&
      gesture.toWorkspace !== null &&
      (Math.abs(
        event.totalY * this.workspaceGestureSpeed.workspaceSwitchFactor,
      ) >=
        gesture.distance * WORKSPACE_GESTURE_THRESHOLD_RATIO ||
        Math.abs(
          event.velocityY *
            this.workspaceGestureSpeed.workspaceSwitchVelocityFactor,
        ) >= WORKSPACE_GESTURE_VELOCITY_THRESHOLD);

    if (shouldCommit && gesture.toWorkspace) {
      this.activeWorkspaceByMonitor.set(
        gesture.monitor,
        gesture.currentIndex + gesture.direction,
      );
      this.currentMonitor = gesture.monitor;
      gesture.fromWorkspace.animateWorkspaceTransition({
        fromOffsetY: gesture.fromOffsetY,
        toOffsetY: -gesture.direction * gesture.distance,
        fromOpacity: gesture.fromOpacity,
        toOpacity: 0,
        visibleAfter: false,
      });
      gesture.toWorkspace.animateWorkspaceTransition({
        fromOffsetY: gesture.toOffsetY,
        toOffsetY: 0,
        fromOpacity: gesture.toOpacity,
        toOpacity: 1,
        visibleAfter: true,
      });
      gesture.toWorkspace.focusActiveWindow();
      this.applyWorkspaceStackPolicy(gesture.fromWorkspace);
      this.applyWorkspaceStackPolicy(gesture.toWorkspace);
      return;
    }

    gesture.fromWorkspace.animateWorkspaceTransition({
      fromOffsetY: gesture.fromOffsetY,
      toOffsetY: 0,
      fromOpacity: gesture.fromOpacity,
      toOpacity: 1,
      visibleAfter: true,
    });
    if (gesture.toWorkspace) {
      gesture.toWorkspace.animateWorkspaceTransition({
        fromOffsetY: gesture.toOffsetY,
        toOffsetY: gesture.direction * gesture.distance,
        fromOpacity: gesture.toOpacity,
        toOpacity: 0,
        visibleAfter: false,
      });
    }
    this.applyWorkspaceStackPolicy(gesture.fromWorkspace);
  }

  private workspaceTransitionDistance(monitor: string): number {
    return read(this.workspaceViewportRect(monitor).height);
  }

  // ================
  // POINTER & OUTPUT
  // ================
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

    // Workspace slots persist forever, keyed by connector name (Hyprland-style
    // persistent workspaces) — never deleted on disconnect, so a returning
    // monitor just picks its 10 slots back up untouched. Only the windows on
    // them need to move somewhere usable while the monitor is offline.
    const orphanedWorkspaces = Array.from(this.workspaces.values()).filter(
      (workspace) =>
        !liveMonitors.has(workspace.monitor) && workspace.windowCount() > 0,
    );
    if (orphanedWorkspaces.length > 0) {
      const fallbackWorkspace = this.workspaceForMonitor(fallbackMonitor)!;
      for (const workspace of orphanedWorkspaces) {
        for (const window of workspace.allWindows().slice()) {
          const taken = workspace.takeWindowForMove(window);
          if (taken) {
            fallbackWorkspace.addMovedWindow(window, taken.snapshot);
          }
        }
      }
      this.applyWorkspaceStackPolicy(fallbackWorkspace);
      fallbackWorkspace.applyLayout({
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

  // =========
  // TILE DRAG
  // =========
  private workspaceForTileDrag(
    event: WindowMoveEvent,
    drag: NonNullable<HybridWindowManager["tileDrag"]>,
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

  // ====================
  // FLOATING DRAG & SNAP
  // ====================
  private workspaceForFloatingDrag(
    event: WindowMoveEvent,
    drag: NonNullable<HybridWindowManager["floatingDrag"]>,
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

  // Reuses monocle padding as the snap-rect inset for edge-to-edge consistency.
  private monitorSnapBaseRect(monitor: string): ManagedWindowRect | null {
    const usable =
      COMPOSITOR.layer.usableArea(monitor) ??
      this.monitorFullRect(monitor);
    if (!usable) {
      return null;
    }
    return insetRect(usable, MONOCLE_WINDOW_PADDING);
  }

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
    if (nearTop) return "monocle";
    if (nearLeft) return "left";
    if (nearRight) return "right";
    return null;
  }

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
      case "monocle":
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

  // Returns true if snapped, so caller skips its own drop-position handling.
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
    const isMonocle = window.state[WINDOW_STATE_MONOCLE]();

    if (snap.zone === "monocle") {
      this.clearWindowSnapState(window);
      // Real maximize() keeps the compositor's isMaximized/SSD icon in sync.
      if (!isMonocle) {
        window.maximize();
      } else {
        const rect = this.monocleRectForWindow(window);
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
      // Clear restore rect first so unmaximize() doesn't fight the snap anim.
      if (isMonocle) {
        window.state[WINDOW_STATE_RESTORE_RECT].set(null);
        window.state[WINDOW_STATE_MONOCLE].set(false);
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

  // ==========
  // IPC & VIEW
  // ==========
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
        .map((window) => {
          const rect = window.state[WINDOW_STATE_RECT]();
          return {
            id: window.id,
            appId: window.appId(),
            title: window.title(),
            active: window.isFocused(),
            urgent: window.state[WINDOW_STATE_URGENT](),
            monocle: window.state[WINDOW_STATE_MONOCLE](),
            lastFocusedAt: this.lastFocusedAt.get(window.id) ?? 0,
            position: { x: read(rect.x), y: read(rect.y) },
            size: { width: read(rect.width), height: read(rect.height) },
          };
        });
      list.push({
        index: workspace.index,
        windowCount: workspace.windowCount(),
        active,
        windows,
      });
      byMonitor.set(workspace.monitor, list);
    }

    const monitors: WorkspacesViewMonitor[] = COMPOSITOR.output.list.map(
      (name) => {
        const active = this.activeWorkspaceByMonitor.get(name) ?? 1;
        // Ten persistent workspaces
        const workspaces = (byMonitor.get(name) ?? []).slice();
        workspaces.sort((a, b) => a.index - b.index);
        return { name, active, workspaces, rect: this.monitorFullRect(name) };
      },
    );

    return { currentMonitor: this.currentMonitor, monitors };
  }

  public findWindowById(windowId: string): WaylandWindow | undefined {
    for (const workspace of this.workspaces.values()) {
      const found = workspace.findWindowById(windowId);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  public listWindows(): WaylandWindow[] {
    const windows: WaylandWindow[] = [];
    for (const workspace of this.workspaces.values()) {
      windows.push(...workspace.listWindows());
    }
    return windows;
  }

  // Synchronous pan (not onFocus) matches Super+Ctrl+Left/Right's animation.
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

    // Skips implicit focus — its onFocus cycle would override our pan below.
    this.switchWorkspaceTo(workspace.monitor, workspace.index, {
      focusActiveAfter: false,
    });

    workspace.panToWindow(window);

    // Focus last so it overrides switchWorkspaceTo's focusActiveWindow().
    window.focus();
    return true;
  }

  // Plays the same slide/fade transition as keyboard/gesture switching.
  public getWindowZIndex(window: WaylandWindow): ReadonlySignal<number> {
    return this.windowStack.zIndex(window);
  }

  public setSnapPreviewBroadcaster(broadcaster: SnapPreviewBroadcaster | null) {
    this.snapPreviewBroadcaster = broadcaster;
  }

  public setWorkspaceChangeBroadcaster(
    broadcaster: WorkspaceChangeBroadcaster | null,
  ) {
    this.workspaceChangeBroadcaster = broadcaster;
  }

}
