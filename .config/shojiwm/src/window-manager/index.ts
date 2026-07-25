export type { SnapZone } from "./state";
export {
  WINDOW_STATE_RECT,
  WINDOW_STATE_RESTORE_RECT,
  WINDOW_STATE_MINIMIZED,
  WINDOW_STATE_MINIMIZE_VISUAL_IDLE,
  WINDOW_STATE_MAXIMIZED,
  WINDOW_STATE_FULLSCREEN,
  WINDOW_STATE_FULLSCREEN_RESTORE_RECT,
  WINDOW_STATE_WORKSPACE_VISIBLE,
  WINDOW_STATE_WORKSPACE_OFFSET_Y,
  WINDOW_STATE_WORKSPACE_OPACITY,
  WINDOW_STATE_TILE_DRAGGING,
  WINDOW_STATE_TILED,
  WINDOW_STATE_VISIBLE_OUTPUTS,
  WINDOW_STATE_FLOATING_RECT,
  WINDOW_STATE_SNAP_ZONE,
  WINDOW_STATE_SNAP_MONITOR,
  TILE_ANIMATION_DURATION,
  WINDOW_BORDER_PX,
  TITLEBAR_HEIGHT,
  MAXIMIZED_WINDOW_PADDING,
} from "./state";
export type {
  SnapPreviewRect,
  SnapPreviewPayload,
  SnapPreviewBroadcaster,
  WorkspaceChangeBroadcaster,
  WorkspacesViewWindow,
  WorkspacesViewWorkspace,
  WorkspacesViewMonitor,
  WorkspacesView,
  WorkspaceGestureSpeedConfig,
} from "./state";
export { HybridWindowManager } from "./manager";
export { Workspace } from "./workspace";
