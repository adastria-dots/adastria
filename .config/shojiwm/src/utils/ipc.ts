// TILING IPC
// External control channel for scripts/shojitile, mirroring what
// scripts/hyprtile does over `hyprctl eval` for the Hyprland source config.

import { createIpcServer, type IpcServer } from "shoji_wm/ipc";
import type { WindowManager } from "../window-manager";

export function startTilingIpc(wm: WindowManager): IpcServer {
  const ipc = createIpcServer();

  ipc.handle("workspace/focus", (params) => {
    const { index } = params as { index: number };
    wm.switchWorkspaceTo(wm.getCurrentMonitorName(), index);
  });

  ipc.handle("window/move", (params) => {
    const { index, windowId, follow } = params as {
      index: number;
      windowId?: string;
      follow?: boolean;
    };
    wm.moveWindowToWorkspaceIndex(windowId, index, follow ?? true);
  });

  ipc.handle("window/close", (params) => {
    const { scope } = (params as { scope?: number | "a" }) ?? {};
    wm.closeWorkspaceWindows(scope);
  });

  ipc.handle("workspace/moveInto", (params) => {
    const { index } = params as { index: number };
    wm.moveWorkspaceInto(index);
  });

  ipc.handle("workspace/swap", (params) => {
    const { index } = params as { index: number };
    wm.swapActiveWorkspaceWith(index);
  });

  return ipc;
}
