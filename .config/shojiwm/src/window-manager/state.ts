import { createWindowState, cubicBezier, seconds } from "shoji_wm";
import type { ManagedWindowRect } from "shoji_wm/types";
import type { Workspace } from "./workspace";

export type SnapZone =
  | "maximize"
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
export const WINDOW_STATE_MAXIMIZED = createWindowState<boolean>("maximized", {
  default: false,
});
export const WINDOW_STATE_FULLSCREEN = createWindowState<boolean>(
  "fullscreen",
  {
    default: false,
  },
);
// Pre-fullscreen rect, kept separate from WINDOW_STATE_RESTORE_RECT so a
// window that was maximized before going fullscreen restores back to its
// maximized rect (and the maximize restore rect underneath stays intact).
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
export const OPEN_CLOSE_ANIMATION_DURATION = seconds(0.22);
export const WINDOW_MANAGEMENT_ANIMATION_DURATION = seconds(0.2);
export const UNMAXIMIZE_GRAB_ANIMATION_DURATION = 90;
export const WINDOW_MANAGEMENT_EASING = cubicBezier(0.1, 0.9, 0.2, 1.0);
export const WINDOW_OPEN_EASING = cubicBezier(0.1, 1.1, 0.1, 1.1);
export const WINDOW_CLOSE_EASING = cubicBezier(0.3, -0.3, 0, 1);
export const WINDOW_MINIMIZE_RECT_EASING = cubicBezier(0.3, -0.3, 0, 1);
export const WINDOW_UNMINIMIZE_RECT_EASING = cubicBezier(0.1, 1.1, 0.1, 1.1);
export const WINDOW_MINIMIZE_OPACITY_EASING = cubicBezier(0.3, -0.3, 0, 1);
export const WINDOW_UNMINIMIZE_OPACITY_EASING = cubicBezier(0.1, 1.1, 0.1, 1.1);
export const TILE_ANIMATION_DURATION = seconds(0.18);
export const WORKSPACE_SWITCH_ANIMATION_DURATION = seconds(0.25);
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
// Single gap value used both between tiled windows and between a tile and
// the screen edge, so the two always look consistent.
export const TILE_GAP = 20;
export const TILE_MAX_COLUMNS = 2;
export const TILE_MIN_WIDTH = 240;
// Windows-style edge snapping for floating drags. Distances are logical px.
//   - within SNAP_EDGE_PX of an edge triggers that edge's zone
//   - within SNAP_CORNER_PX of a corner (along both axes) triggers a quarter
//   - SNAP_GAP_PX is the gap left between adjacent halves/quarters
export const SNAP_EDGE_PX = 16;
export const SNAP_CORNER_PX = 140;
export const SNAP_GAP_PX = 8;
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
  isTiled: boolean;
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
  maximized: boolean;
}
/**
 * Compact, serializable view of the workspace layout for external clients
 * (e.g. the bar) consumed over the IPC transport. Per-monitor so a per-output
 * bar can render just its own workspaces.
 */
export interface WorkspacesViewWindow {
  id: string;
  appId?: string;
  title: string;
  focused: boolean;
  /** epoch ms — most recent focus time for MRU ordering. 0 if never focused. */
  lastFocusedAt: number;
}

export interface WorkspacesViewWorkspace {
  index: number;
  windowCount: number;
  isTiled: boolean;
  active: boolean;
  windows: WorkspacesViewWindow[];
}

export interface WorkspacesViewMonitor {
  name: string;
  active: number;
  workspaces: WorkspacesViewWorkspace[];
}

export interface WorkspacesView {
  currentMonitor: string;
  monitors: WorkspacesViewMonitor[];
}
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
  /**
   * Horizontal three-finger swipe movement multiplier for scrolling inside a
   * tiled workspace.
   */
  workspaceScrollFactor?: number;
  /**
   * Horizontal release velocity multiplier for kinetic workspace scrolling.
   * Defaults to workspaceScrollFactor when omitted.
   */
  workspaceScrollKineticFactor?: number;
  /**
   * Vertical three-finger swipe movement multiplier for workspace switching.
   */
  workspaceSwitchFactor?: number;
  /**
   * Vertical release velocity multiplier for deciding whether to commit a
   * workspace switch. Defaults to workspaceSwitchFactor when omitted.
   */
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
export const WINDOW_BORDER_PX = 5;
export const TITLEBAR_HEIGHT = 30;
export const MAXIMIZED_WINDOW_PADDING = {
  top: TILE_GAP,
  right: TILE_GAP,
  bottom: TILE_GAP,
  left: TILE_GAP,
};
