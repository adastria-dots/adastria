import {
  Box,
  ClientWindow,
  ShaderEffect,
  COMPOSITOR,
  WindowBorder,
  backdropSource,
  compileEffect,
  type WaylandWindow,
  computed,
  shaderStage,
  loadShader,
  ManagedWindow,
  read,
  type DisplayConfigDraft,
  signal,
  createPoll,
  type PollHandle,
} from "shoji_wm";
import type { ManagedWindowRect } from "shoji_wm/types";
import { createIpcServer } from "shoji_wm/ipc";
import {
  WindowManager,
  WINDOW_BORDER_PX,
  WINDOW_STATE_FULLSCREEN,
  WINDOW_STATE_MINIMIZED,
  WINDOW_STATE_MINIMIZE_VISUAL_IDLE,
  WINDOW_STATE_MONOCLE,
  WINDOW_STATE_TILE_DRAGGING,
  WINDOW_STATE_FLOATING,
  WINDOW_STATE_VISIBLE_OUTPUTS,
  WINDOW_STATE_RECT,
  WINDOW_STATE_WORKSPACE_VISIBLE,
  WINDOW_STATE_WORKSPACE_OFFSET_Y,
  WINDOW_STATE_WORKSPACE_OPACITY,
} from "./window-manager";

interface ThemeColors {
  accent: string;
  accentAlt: string;
  lavender: string;
  textDim: string;
  text: string;
}

// Color Palette
const theme: ThemeColors = {
  accent: "#7B2FE8",
  accentAlt: "#C8942A",
  lavender: "#5E50A0",
  textDim: "#5E50A0",
  text: "#F0ECF8",
};

COMPOSITOR.env.apply({
  QT_QPA_PLATFORM: "wayland;xcb",
  QT_QPA_PLATFORMTHEME: "qt6ct",
  QT_IM_MODULE: "fcitx",
  XMODIFIERS: "@im=fcitx",
  SDL_IM_MODULE: "fcitx",
  GLFW_IM_MODULE: "fcitx",
  ELECTRON_OZONE_PLATFORM_HINT: "wayland",
});
COMPOSITOR.env.publish();

COMPOSITOR.cursor.configure({
  theme: "Keqing",
  size: 24,
});

COMPOSITOR.window.decoration.configure((window, context) => {
  const appId = (window.appId() ?? "").toLowerCase();
  const isFirefox =
    appId === "firefox" ||
    appId.endsWith(".firefox") ||
    appId.includes("firefoxdeveloperedition");

  // Early SSD before appId is known permanently breaks some browsers' chrome.
  if (appId.length === 0) {
    return { mode: context.clientPreference ?? "client" };
  }

  // Firefox renegotiates repeatedly if CSD is rejected — always keep CSD.
  if (isFirefox) {
    return { mode: "client" };
  }

  return { mode: "server" };
});

// Per-monitor default column count
const TILE_COLUMNS_BY_MONITOR: Record<string, number> = {};

const WINDOW_MANAGER = new WindowManager(
  naturalRootRect,
  TILE_COLUMNS_BY_MONITOR,
);
const HOT_RELOAD_WINDOW_MANAGER_STATE = "config.window-manager";
const FULLSCREEN_Z_INDEX = 2_000_000_000;

const LIQUID_RIPPLE_FALLBACK_REFRESH_RATE = 120;
const liquidRippleTime = signal(0);
let liquidRipplePoll: PollHandle | null = null;
let liquidRippleStartedAtMs = Date.now();

const LIQUID_RIPPLE_UNIFORMS = {
  time: liquidRippleTime,
  wave_speed: 0.2,
  wave_speed_x: 0.3,
  wave_speed_y: 0.3,
  emboss: 0.4,
  intensity: 2.0,
  frequency: 6.0,
  refraction_strength: 1.5,
  reflection_gain: 500.0,
  reflection_cutoff: 0.012,
  reflection_intensity: 150000.0,
  water_tint: 0.92,
};

function maxOutputRefreshRate(): number {
  const refreshRates = COMPOSITOR.output.outputs
    .map((output) => output.resolution?.refreshRate)
    .filter((r): r is number => typeof r === "number" && r > 0);
  return refreshRates.length === 0
    ? LIQUID_RIPPLE_FALLBACK_REFRESH_RATE
    : Math.max(...refreshRates);
}

function restartLiquidRippleClock(): void {
  const elapsedMs = liquidRippleTime.peek() * 1000;
  liquidRippleStartedAtMs = Date.now() - elapsedMs;
  liquidRipplePoll?.cancel();
  liquidRipplePoll = createPoll(1000 / maxOutputRefreshRate(), () => {
    liquidRippleTime.value = (Date.now() - liquidRippleStartedAtMs) / 1000;
  });
}

restartLiquidRippleClock();

COMPOSITOR.onDisable((event) => {
  liquidRipplePoll?.cancel();
  liquidRipplePoll = null;

  if (event.isReloading) {
    const snapshot = WINDOW_MANAGER.snapshot();
    event.persist(HOT_RELOAD_WINDOW_MANAGER_STATE, snapshot);
  }
});

COMPOSITOR.onEnable((event) => {
  restartLiquidRippleClock();

  if (event.isReloading) {
    const snapshot = event.restore<
      ReturnType<typeof WINDOW_MANAGER.snapshot>
    >(HOT_RELOAD_WINDOW_MANAGER_STATE);
    if (snapshot) {
      WINDOW_MANAGER.restore(snapshot);
    }
  }
});

// Notify helper, sends a 1.5s notification
function notify(text: string) {
  COMPOSITOR.process.spawn({ command: ["notify-send", "-t", "1500", text] });
}

// Full message table: local/shojiwm/config.md.
const WORKSPACE_IPC = createIpcServer();
let lastWorkspacesJson = "";
let workspaceBroadcastQueued = false;

function broadcastWorkspaces() {
  const view = WINDOW_MANAGER.viewForIpc();
  const json = JSON.stringify(view);
  if (json === lastWorkspacesJson) {
    return;
  }
  lastWorkspacesJson = json;
  WORKSPACE_IPC.broadcast("workspaces.changed", view);
}

function reconfigureProtocolWorkspaces() {
  COMPOSITOR.workspace.reconfigure();
}

function scheduleWorkspaceBroadcast() {
  // Must stage before this response is written, or bar updates lag a tick.
  reconfigureProtocolWorkspaces();
  if (workspaceBroadcastQueued) {
    return;
  }
  workspaceBroadcastQueued = true;
  void Promise.resolve().then(() => {
    workspaceBroadcastQueued = false;
    broadcastWorkspaces();
  });
}

COMPOSITOR.workspace.configure(() => {
  const view = WINDOW_MANAGER.viewForIpc();
  return {
    groups: view.monitors.map((monitor) => ({
      id: monitor.name,
      outputs: [monitor.name],
      workspaces: monitor.workspaces.map((workspace) => ({
        id: `${monitor.name}:${workspace.index}`,
        name: String(workspace.index),
        coordinates: [Math.max(0, workspace.index - 1)],
        active: workspace.active,
        hidden: !workspace.active && workspace.windowCount === 0,
      })),
    })),
  };
});

COMPOSITOR.workspace.event.onActivate((event) => {
  const [monitor, rawIndex] = event.workspaceId.split(":");
  const index = Number(rawIndex);
  if (!monitor || !Number.isInteger(index) || index < 1) {
    return;
  }
  WINDOW_MANAGER.activate(monitor, index);
  scheduleWorkspaceBroadcast();
});

WORKSPACE_IPC.handle("workspaces.get", () =>
  WINDOW_MANAGER.viewForIpc(),
);
WORKSPACE_IPC.handle("workspaces.switch", (params) => {
  const direction = (params as { direction?: number } | undefined)?.direction;
  WINDOW_MANAGER.switchWorkspace(direction === -1 ? -1 : 1);
  scheduleWorkspaceBroadcast();
});
WORKSPACE_IPC.handle("workspaces.activate", (params) => {
  const request = params as { monitor?: string; index?: number } | undefined;
  if (request?.monitor && typeof request.index === "number") {
    WINDOW_MANAGER.activate(request.monitor, request.index);
    scheduleWorkspaceBroadcast();
  }
});
WORKSPACE_IPC.handle("workspaces.moveWindow", (params) => {
  const request = params as
    | { monitor?: string; index?: number; follow?: boolean }
    | undefined;
  if (request?.monitor && typeof request.index === "number") {
    WINDOW_MANAGER.moveFocusedWindowToWorkspaceIndex(
      request.monitor,
      request.index,
      { follow: request.follow },
    );
    scheduleWorkspaceBroadcast();
  }
});
WORKSPACE_IPC.handle("workspaces.swap", (params) => {
  const request = params as { monitor?: string; index?: number } | undefined;
  if (request?.monitor && typeof request.index === "number") {
    WINDOW_MANAGER.swapWorkspace(request.monitor, request.index);
    scheduleWorkspaceBroadcast();
  }
});
WORKSPACE_IPC.handle("workspaces.moveInto", (params) => {
  const request = params as { monitor?: string; index?: number } | undefined;
  if (request?.monitor && typeof request.index === "number") {
    WINDOW_MANAGER.moveWorkspaceInto(request.monitor, request.index);
    scheduleWorkspaceBroadcast();
  }
});
WORKSPACE_IPC.handle("workspaces.clear", (params) => {
  const request = params as
    | { monitor?: string; index?: number; scope?: string }
    | undefined;
  WINDOW_MANAGER.clearWorkspace(
    request?.monitor,
    request?.index,
    request?.scope === "all" ? "all" : undefined,
  );
  scheduleWorkspaceBroadcast();
});
WORKSPACE_IPC.handle("windows.closeCurrent", () => {
  WINDOW_MANAGER.closeCurrentWorkspaceWindows();
});
WORKSPACE_IPC.handle("windows.closeAll", () => {
  WINDOW_MANAGER.closeAllWindows();
});
WORKSPACE_IPC.handle("windows.close", (params) => {
  const windowId = (params as { windowId?: string } | undefined)?.windowId;
  if (typeof windowId === "string") {
    WINDOW_MANAGER.closeWindowById(windowId);
  } else {
    WINDOW_MANAGER.closeFocusedWindow();
  }
  scheduleWorkspaceBroadcast();
});
WORKSPACE_IPC.handle("windows.focusDirection", (params) => {
  const direction = (params as { direction?: string } | undefined)?.direction;
  if (
    direction === "up" ||
    direction === "down" ||
    direction === "left" ||
    direction === "right"
  ) {
    WINDOW_MANAGER.focusMonitorInDirection(direction);
    scheduleWorkspaceBroadcast();
  }
});
WORKSPACE_IPC.handle("windows.moveDirection", (params) => {
  const request = params as
    | { windowId?: string; direction?: string }
    | undefined;
  if (
    request?.direction === "up" ||
    request?.direction === "down" ||
    request?.direction === "left" ||
    request?.direction === "right"
  ) {
    WINDOW_MANAGER.moveWindowInDirection(request.direction, request.windowId);
    scheduleWorkspaceBroadcast();
  }
});
WORKSPACE_IPC.handle("windows.activate", (params) => {
  const windowId = (params as { windowId?: string } | undefined)?.windowId;
  if (typeof windowId === "string") {
    WINDOW_MANAGER.activateWindowById(windowId);
    scheduleWorkspaceBroadcast();
  }
});
WORKSPACE_IPC.handle("windows.moveTo", (params) => {
  const request = params as
    | { windowId?: string; monitor?: string; index?: number; follow?: boolean }
    | undefined;
  if (
    typeof request?.windowId === "string" &&
    request.monitor &&
    typeof request.index === "number"
  ) {
    WINDOW_MANAGER.moveWindowById(
      request.windowId,
      request.monitor,
      request.index,
      { follow: request.follow },
    );
    scheduleWorkspaceBroadcast();
  }
});
WORKSPACE_IPC.handle("windows.moveManyTo", (params) => {
  const request = params as
    | { windowIds?: string[]; monitor?: string; index?: number }
    | undefined;
  if (
    Array.isArray(request?.windowIds) &&
    request.monitor &&
    typeof request.index === "number"
  ) {
    WINDOW_MANAGER.moveWindowsById(
      request.windowIds,
      request.monitor,
      request.index,
    );
    scheduleWorkspaceBroadcast();
  }
});
WORKSPACE_IPC.handle("windows.swap", (params) => {
  const request = params as
    | { windowIdA?: string; windowIdB?: string }
    | undefined;
  if (
    typeof request?.windowIdA === "string" &&
    typeof request?.windowIdB === "string"
  ) {
    WINDOW_MANAGER.swapWindowsById(
      request.windowIdA,
      request.windowIdB,
    );
    scheduleWorkspaceBroadcast();
  }
});

// Replaces a layer-shell trigger surface, which would eat window clicks.
const DOCK_SHOW_ZONE_PX = 10;
const DOCK_HIDE_ZONE_PX = 120;
const dockProximityByMonitor = new Map<string, boolean>();

function pointerInBottomStrip(
  monitor: string,
  pointerX: number,
  pointerY: number,
  stripPx: number,
): boolean {
  const output = COMPOSITOR.output.get(monitor);
  if (!output || !output.resolution) {
    return false;
  }
  const width = output.resolution.width / output.scale;
  const height = output.resolution.height / output.scale;
  const left = output.position.x;
  const top = output.position.y;
  const right = left + width;
  const bottom = top + height;
  return (
    pointerX >= left &&
    pointerX < right &&
    pointerY >= bottom - stripPx &&
    pointerY < bottom
  );
}

function nextDockProximity(
  monitor: string,
  pointerX: number,
  pointerY: number,
  onTrackedMonitor: boolean,
): boolean {
  if (!onTrackedMonitor) return false;
  const wasInside = dockProximityByMonitor.get(monitor) === true;
  // Hysteretic: narrow show-zone while hidden, wide hide-zone while visible.
  return pointerInBottomStrip(
    monitor,
    pointerX,
    pointerY,
    wasInside ? DOCK_HIDE_ZONE_PX : DOCK_SHOW_ZONE_PX,
  );
}

function updateDockProximity(monitor: string, inside: boolean) {
  if (dockProximityByMonitor.get(monitor) === inside) {
    return;
  }
  dockProximityByMonitor.set(monitor, inside);
  WORKSPACE_IPC.broadcast("dock.proximity", { monitor, inside });
}

// Bar renders the rounded snap-preview overlay from this broadcast.
let lastSnapJson = "";
WINDOW_MANAGER.setSnapPreviewBroadcaster((preview) => {
  const json = JSON.stringify(preview);
  if (json === lastSnapJson) {
    return;
  }
  lastSnapJson = json;
  WORKSPACE_IPC.broadcast("snap.preview", preview);
});

WINDOW_MANAGER.setWorkspaceChangeBroadcaster(() => {
  scheduleWorkspaceBroadcast();
});

COMPOSITOR.onDisable(() => {
  WORKSPACE_IPC.close();
});

COMPOSITOR.process.once("fcitx5", {
  command: "fcitx5 -d",
  runPolicy: "once-per-session",
});

COMPOSITOR.process.once("kokusei", {
  command: "kokusei",
  runPolicy: "once-per-session",
});

COMPOSITOR.process.service("cliphist-text", {
  command: ["wl-paste", "--type", "text", "--watch", "cliphist", "store"],
  restart: "on-exit",
});
COMPOSITOR.process.service("cliphist-image", {
  command: ["wl-paste", "--type", "image", "--watch", "cliphist", "store"],
  restart: "on-exit",
});

COMPOSITOR.key.bind("terminal", "Super+T", () => {
  COMPOSITOR.process.spawn({ command: ["kitty"] });
});

COMPOSITOR.key.bind("chrome", "Super+B", () => {
  COMPOSITOR.process.spawn({ command: ["zen-browser"] });
});

COMPOSITOR.key.bind("dolphin", "Super+E", () => {
  COMPOSITOR.process.spawn({ command: ["kitty", "yazi"] });
});
COMPOSITOR.key.bind("logout", "Super+Q", () => {
  COMPOSITOR.process.spawn({ command: ["kokusei", "logout"] });
});
COMPOSITOR.key.bind("launcher", "Shift+Space", () => {
  COMPOSITOR.process.spawn({ command: ["kokusei", "launcher"] });
});

COMPOSITOR.key.bind("code", "Super+C", () => {
  COMPOSITOR.process.spawn({ command: ["code"] });
});
COMPOSITOR.key.bind("code-keqing-shell", "Super+Alt+K", () => {
  COMPOSITOR.process.spawn({
    command: ["code", `${process.env.HOME}/keqing-shell`],
  });
});
COMPOSITOR.key.bind("code-keqing-dots", "Super+Shift+K", () => {
  COMPOSITOR.process.spawn({
    command: ["code", `${process.env.HOME}/keqing-dots`],
  });
});
COMPOSITOR.key.bind("screenshot-region-freeze", "Super+Shift+S", () => {
  COMPOSITOR.process.spawn({
    command: "screenshot",
  });
});

COMPOSITOR.key.bind("tile-focus-left-quick", "Super+Left", () => {
  WINDOW_MANAGER.focusAdjacent(-1);
});
COMPOSITOR.key.bind("tile-focus-right-quick", "Super+Right", () => {
  WINDOW_MANAGER.focusAdjacent(1);
});
COMPOSITOR.key.bind("tile-focus-up", "Super+Up", () => {
  WINDOW_MANAGER.focusAdjacent(-1);
});
COMPOSITOR.key.bind("tile-focus-down", "Super+Down", () => {
  WINDOW_MANAGER.focusAdjacent(1);
});
COMPOSITOR.key.bind("window-monocle-toggle", "Super+F", () => {
  WINDOW_MANAGER.toggleFocusedWindowMonocle();
});
COMPOSITOR.key.bind("window-close", "Super+W", () => {
  WINDOW_MANAGER.closeFocusedWindow();
});
COMPOSITOR.key.bind("tile-move-left", "Super+Shift+Left", () => {
  WINDOW_MANAGER.reorderFocused(-1);
  scheduleWorkspaceBroadcast();
});
COMPOSITOR.key.bind("tile-move-right", "Super+Shift+Right", () => {
  WINDOW_MANAGER.reorderFocused(1);
  scheduleWorkspaceBroadcast();
});
COMPOSITOR.key.bind("window-move-monitor-up", "Super+Shift+Up", () => {
  WINDOW_MANAGER.adaptiveMoveFocusedWindow("up");
  scheduleWorkspaceBroadcast();
});
COMPOSITOR.key.bind("window-move-monitor-down", "Super+Shift+Down", () => {
  WINDOW_MANAGER.adaptiveMoveFocusedWindow("down");
  scheduleWorkspaceBroadcast();
});
COMPOSITOR.key.bind("window-fullscreen-toggle", "Super+Shift+F", () => {
  WINDOW_MANAGER.toggleFocusedWindowFullscreen();
});
COMPOSITOR.key.bind("window-float-toggle", "Super+V", () => {
  WINDOW_MANAGER.toggleFocusedWindowFloating();
});
COMPOSITOR.key.bind("tile-columns-increase", "Super+equal", () => {
  const result = WINDOW_MANAGER.setMaxColumns(1);
  if (result) {
    notify(`Workspace: ${result.index}\nColumns: ${result.columns}`);
  }
  scheduleWorkspaceBroadcast();
});
COMPOSITOR.key.bind("tile-columns-decrease", "Super+minus", () => {
  const result = WINDOW_MANAGER.setMaxColumns(-1);
  if (result) {
    notify(`Workspace: ${result.index}\nColumns: ${result.columns}`);
  }
  scheduleWorkspaceBroadcast();
});
COMPOSITOR.key.bind("tile-columns-strict-toggle", "Super+Shift+equal", () => {
  const result = WINDOW_MANAGER.toggleStrictColumns();
  if (result) {
    notify(
      `Workspace: ${result.index}\nStrict Columns: ${result.strict ? "On" : "Off"}`,
    );
  }
  scheduleWorkspaceBroadcast();
});
COMPOSITOR.key.bind("tile-columns-reset", "Super+Shift+minus", () => {
  const result = WINDOW_MANAGER.resetWorkspaceLayout();
  if (result) {
    notify(`Workspace: ${result.index}\nReset to defaults`);
  }
  scheduleWorkspaceBroadcast();
});

for (let i = 1; i <= 10; i++) {
  const key = i % 10;
  COMPOSITOR.key.bind(`workspace-activate-${key}`, `Super+${key}`, () => {
    WINDOW_MANAGER.activate(
      WINDOW_MANAGER.getCurrentMonitorName(),
      i,
    );
    scheduleWorkspaceBroadcast();
  });
  COMPOSITOR.key.bind(`workspace-swap-${key}`, `Super+Ctrl+${key}`, () => {
    WINDOW_MANAGER.swapWorkspace(
      WINDOW_MANAGER.getCurrentMonitorName(),
      i,
    );
    scheduleWorkspaceBroadcast();
  });
  COMPOSITOR.key.bind(`workspace-move-window-${key}`, `Super+Shift+${key}`, () => {
    WINDOW_MANAGER.moveFocusedWindowToWorkspaceIndex(
      WINDOW_MANAGER.getCurrentMonitorName(),
      i,
    );
    scheduleWorkspaceBroadcast();
  });
}

COMPOSITOR.key.bind("volume-lower", "XF86AudioLowerVolume", () => {
  COMPOSITOR.process.spawn({
    command: "wpctl set-volume @DEFAULT_AUDIO_SINK@ 1%-",
  });
});
COMPOSITOR.key.bind("volume-raise", "XF86AudioRaiseVolume", () => {
  COMPOSITOR.process.spawn({
    command: "wpctl set-volume -l 1 @DEFAULT_AUDIO_SINK@ 1%+",
  });
});
COMPOSITOR.key.bind("volume-mute", "XF86AudioMute", () => {
  COMPOSITOR.process.spawn({
    command: "wpctl set-mute @DEFAULT_AUDIO_SINK@ toggle",
  });
});
COMPOSITOR.key.bind("mic-mute", "XF86AudioMicMute", () => {
  COMPOSITOR.process.spawn({
    command: "wpctl set-mute @DEFAULT_AUDIO_SOURCE@ toggle",
  });
});
COMPOSITOR.key.bind("brightness-down", "XF86MonBrightnessDown", () => {
  COMPOSITOR.process.spawn({
    command: "brightnessctl -e4 -n2 set 1%-",
  });
});
COMPOSITOR.key.bind("brightness-up", "XF86MonBrightnessUp", () => {
  COMPOSITOR.process.spawn({
    command: "brightnessctl -e4 -n2 set 1%+",
  });
});

COMPOSITOR.output.configure((context) => {
  const display: DisplayConfigDraft = {};

  for (const output of context.connected) {
    display[output.name] = {
      mode: "extend",
      resolution: "best",
      position: "auto",
      scale: 1,
    };
  }

  const isDocked = context.connected.some(
    (output) => output.name === "HDMI-A-1",
  );
  if (isDocked) {
    display["eDP-1"] = { mode: "disabled" };
    display["eDP-2"] = { mode: "disabled" };
  }

  return display;
});

COMPOSITOR.input.configure((input, _context) => {
  input.global = {
    touchpad: {
      tapToClick: true,
      naturalScroll: true,
      scrollMethod: "twoFinger",
      disableWhileTyping: true,
      scrollFactor: 0.3,
    },
    pointer: {
      pointerAccel: 0.0,
      accelProfile: "flat",
    },
    keyboard: {
      options: "caps:ctrl_modifier",
      repeatRate: 60,
      repeatDelay: 250,
    },
  };

  input.device["Razer Razer Blade Keyboard"] = {
    keyboard: {
      layout: "us",
    },
  };
});

WINDOW_MANAGER.configureWorkspaceGestureSpeed({
  workspaceScrollFactor: 1.5,
  workspaceScrollKineticFactor: 1,
  workspaceSwitchFactor: 1,
  workspaceSwitchVelocityFactor: 1,
});

COMPOSITOR.event.onOpen((window) => {
  WINDOW_MANAGER.onOpen(window);
});

COMPOSITOR.event.onFirstCommit((window) => {
  WINDOW_MANAGER.onFirstCommit(window);
  scheduleWorkspaceBroadcast();
});

COMPOSITOR.event.onStartClose((window) => {
  WINDOW_MANAGER.onStartClose(window);
  scheduleWorkspaceBroadcast();
});

COMPOSITOR.event.onClose((window) => {
  WINDOW_MANAGER.onClose(window);
  scheduleWorkspaceBroadcast();
});

COMPOSITOR.event.onFocus((window, focused) => {
  WINDOW_MANAGER.onFocus(window, focused);
  if (focused) {
    WINDOW_MANAGER.recordFocus(window.id);
    scheduleWorkspaceBroadcast();
  }
});

COMPOSITOR.event.onPointerMoveAsync((event) => {
  WINDOW_MANAGER.onPointerMove(event);

  // Also emits "leave" for other monitors that were previously inside.
  const pointerX = event.position.x;
  const pointerY = event.position.y;
  for (const monitor of COMPOSITOR.output.list) {
    const inside = nextDockProximity(
      monitor,
      pointerX,
      pointerY,
      monitor === event.outputName,
    );
    updateDockProximity(monitor, inside);
  }
});

COMPOSITOR.event.onGestureSwipeAsync((event) => {
  WINDOW_MANAGER.onGestureSwipe(event);
  scheduleWorkspaceBroadcast();
});

COMPOSITOR.event.onOutputChange((event) => {
  WINDOW_MANAGER.onOutputChange(event);
  scheduleWorkspaceBroadcast();
});

COMPOSITOR.event.onCreateLayer(() => {
  WINDOW_MANAGER.refreshUsableAreaLayouts();
});

COMPOSITOR.event.onUpdateLayer(() => {
  WINDOW_MANAGER.refreshUsableAreaLayouts();
});

COMPOSITOR.event.onDestroyLayer(() => {
  WINDOW_MANAGER.refreshUsableAreaLayouts();
});

COMPOSITOR.event.onWindowResize((event) => {
  WINDOW_MANAGER.onWindowResize(event);
});

COMPOSITOR.pointer.bindWindowMoveModifier("Super");
COMPOSITOR.pointer.bindWindowResizeModifier("Super");

COMPOSITOR.event.onWindowMove((event) => {
  WINDOW_MANAGER.onWindowMove(event);
});

COMPOSITOR.event.onWindowMaximizeRequest((event) => {
  WINDOW_MANAGER.onWindowMaximizeRequest(event);
});

COMPOSITOR.event.onWindowMinimizeRequest((event) => {
  WINDOW_MANAGER.onWindowMinimizeRequest(event);
});

COMPOSITOR.event.onWindowFullscreenRequest((event) => {
  WINDOW_MANAGER.onWindowFullscreenRequest(event);
});

COMPOSITOR.event.onWindowActivateRequest((event) => {
  WINDOW_MANAGER.onWindowActivateRequest(event);
  scheduleWorkspaceBroadcast();
});

function naturalRootRect(window: WaylandWindow): ManagedWindowRect {
  const client = window.position;
  return {
    x: client.x - WINDOW_BORDER_PX,
    y: client.y - WINDOW_BORDER_PX,
    width: client.width + WINDOW_BORDER_PX * 2,
    height: client.height + WINDOW_BORDER_PX * 2,
  };
}

COMPOSITOR.window.composition = (window: WaylandWindow) => {
  const workspaceVisible = window.state[WINDOW_STATE_WORKSPACE_VISIBLE];
  const workspaceOffsetY = window.state[WINDOW_STATE_WORKSPACE_OFFSET_Y];
  const workspaceOpacity = window.state[WINDOW_STATE_WORKSPACE_OPACITY];
  const tileDragging = window.state[WINDOW_STATE_TILE_DRAGGING];
  const managedRect = computed(() => {
    const rect = window.state[WINDOW_STATE_RECT]();
    return {
      x: read(rect.x),
      y: read(rect.y) + workspaceOffsetY(),
      width: read(rect.width),
      height: read(rect.height),
    };
  });
  const tiled = computed(
    () => window.appId() === "mpv" || !window.state[WINDOW_STATE_FLOATING](),
  );
  const forceRectSize = computed(
    () =>
      window.isResizable() &&
      !window.isTransient() &&
      (tiled() ||
        window.state[WINDOW_STATE_FULLSCREEN]() ||
        window.state[WINDOW_STATE_MONOCLE]()),
  );
  const minimizeVisualIdle = window.state[WINDOW_STATE_MINIMIZE_VISUAL_IDLE];
  const inactive = computed(
    () => minimizeVisualIdle() || (!workspaceVisible() && !tileDragging()),
  );

  const monocle = window.state[WINDOW_STATE_MONOCLE];
  const floating = computed(() => window.state[WINDOW_STATE_FLOATING]());
  const borderColor = computed(() =>
    floating()
      ? window.isFocused()
        ? "#FFFFFF"
        : "#FFFFFFAA"
      : monocle()
        ? window.isFocused()
          ? theme.accentAlt
          : `${theme.accentAlt}AA`
        : window.isFocused()
          ? theme.accent
          : `${theme.textDim}AA`,
  );

  const WINDOW_OPACITY_RULES: Record<string, number> = {
    "code-oss": 0.7,
  };

  // Windows in WINDOW_OPACITY_RULES blend via a post-hoc compositor `opacity`,
  // not native surface alpha, so they don't generate the client repaint damage
  // that keeps the backdrop capture (and thus the ripple) recapturing under
  // "on-source-damage-box" — an idle editor freezes the ripple on its last
  // captured frame. Force per-frame recapture for those; damage-gated capture
  // is fine (and cheaper) for native-alpha windows like kitty/ghostty, which
  // already repaint often enough to look continuous.
  const backgroundShader = compileEffect({
    input: backdropSource(),
    capturePadding: 24,
    invalidate:
      window.appId() && window.appId()! in WINDOW_OPACITY_RULES
        ? { kind: "always" }
        : { kind: "on-source-damage-box", damagePadding: 8 },
    pipeline: [
      shaderStage(loadShader("./src/shaders/liquid-ripple.frag"), {
        uniforms: LIQUID_RIPPLE_UNIFORMS,
      }),
    ],
  });
  // appId() resolves asynchronously for some clients (Electron included) —
  // read it inside computed() so a late-arriving appId still applies, rather
  // than baking in an incorrect ruleOpacity from the first composition pass.
  const effectiveOpacity = computed(
    () =>
      workspaceOpacity() * (WINDOW_OPACITY_RULES[window.appId() ?? ""] ?? 1),
  );

  var innerComponents = <ClientWindow />;

  const TERMINALS = ["kitty", "ghostty"];
  const RIPPLE_APPS = [...TERMINALS, "zen"];

  if (RIPPLE_APPS.includes(window.appId() ?? "")) {
    innerComponents = (
      <ShaderEffect shader={backgroundShader} direction="column">
        <ClientWindow />
      </ShaderEffect>
    );
  }

  // Bare ClientWindow, no chrome — lets the tty backend direct-scanout it.
  if (window.state[WINDOW_STATE_FULLSCREEN]()) {
    return (
      <ManagedWindow
        rect={managedRect}
        zIndex={FULLSCREEN_Z_INDEX}
        visibleOutputs={window.state[WINDOW_STATE_VISIBLE_OUTPUTS]}
        opacity={effectiveOpacity}
        forceRectSize={forceRectSize}
        tiled={tiled}
        idle={inactive}
        interactive={inactive((value) => !value)}
        // No-op except direct-scanout clients committing above refresh rate.
        allowTearing={true}
      >
        <ClientWindow />
      </ManagedWindow>
    );
  }

  if (window.decoration().mode === "client") {
    return (
      <ManagedWindow
        rect={managedRect}
        zIndex={WINDOW_MANAGER.getWindowZIndex(window)}
        visibleOutputs={window.state[WINDOW_STATE_VISIBLE_OUTPUTS]}
        opacity={effectiveOpacity}
        forceRectSize={forceRectSize}
        tiled={tiled}
        idle={inactive}
        interactive={inactive((value) => !value)}
      >
        <ClientWindow />
      </ManagedWindow>
    );
  }

  return (
    <ManagedWindow
      rect={managedRect}
      zIndex={WINDOW_MANAGER.getWindowZIndex(window)}
      visibleOutputs={window.state[WINDOW_STATE_VISIBLE_OUTPUTS]}
      opacity={effectiveOpacity}
      forceRectSize={forceRectSize}
      tiled={tiled}
      idle={inactive}
      interactive={inactive((value) => !value)}
    >
      <WindowBorder
        style={{
          border: { px: WINDOW_BORDER_PX, color: borderColor },
          borderRadius: 10,
          background: "#10131900",
          padding: 0,
          paddingX: 0,
          paddingRight: 0,
        }}
        interaction={{
          // Tiled windows are never user-resizable.
          resizeHitArea: {
            edgePx: tiled((isTiled) => (isTiled ? 0 : 8)),
            cornerPx: tiled((isTiled) => (isTiled ? 0 : 14)),
          },
        }}
      >
        <Box direction="row">{innerComponents}</Box>
      </WindowBorder>
    </ManagedWindow>
  );
};

export default COMPOSITOR;
