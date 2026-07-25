// SHOJIWM CONFIG (keqing-dots)

import {
  COMPOSITOR,
  ClientWindow,
  ManagedWindow,
  WindowBorder,
  computed,
  read,
  type WaylandWindow,
} from "shoji_wm";
import type { ManagedWindowRect } from "shoji_wm/types";
import {
  WindowManager,
  WINDOW_STATE_FULLSCREEN,
  WINDOW_STATE_MINIMIZE_VISUAL_IDLE,
  WINDOW_STATE_RECT,
  WINDOW_STATE_TILE_DRAGGING,
  WINDOW_STATE_TILED,
  WINDOW_STATE_VISIBLE_OUTPUTS,
  WINDOW_STATE_WORKSPACE_OFFSET_Y,
  WINDOW_STATE_WORKSPACE_OPACITY,
  WINDOW_STATE_WORKSPACE_VISIBLE,
} from "./window-manager";
import { HOSTNAME, loadDevice, mod } from "./utils/bootstrap";
import { APP, COL, ROOT, SHELL, WORKSPACES_PER_MONITOR } from "./utils/variables";
import { startTilingIpc } from "./utils/ipc";

// =====================
// ENVIRONMENT VARIABLES
// =====================
COMPOSITOR.env.apply({
  // Core
  KEQING_DOTS_ROOT: ROOT,
  WORKSPACES_PER_MONITOR,

  // Input method
  QT_IM_MODULE: "fcitx",
  XMODIFIERS: "@im=fcitx",
  INPUT_METHOD: "fcitx",
  SDL_IM_MODULE: "fcitx",

  // Toolkit
  XDG_MENU_PREFIX: "arch-",
  QT_QPA_PLATFORMTHEME: "qt6ct",
  GTK_THEME: "Adwaita:dark",
  GTK_APPLICATION_PREFER_DARK_THEME: "1",
  QT_STYLE_OVERRIDE: "Fusion",
  QT_QUICK_CONTROLS_STYLE: "Fusion",
  QT_THEME: "dark",

  // Session
  XDG_SESSION_TYPE: "wayland",

  // Wayland
  QT_QPA_PLATFORM: "wayland;xcb",
  GDK_BACKEND: "wayland,x11",
  MOZ_ENABLE_WAYLAND: "1",
  GTK_USE_PORTAL: "1",
});
COMPOSITOR.env.publish();

// ==============
// CURSOR THEME
// ==============
COMPOSITOR.cursor.configure({
  theme: "Keqing",
  size: 24,
});

// ===================
// WINDOW MANAGER
// ===================
const BORDER_PX = 5;

function naturalRootRect(window: WaylandWindow): ManagedWindowRect {
  const client = window.position;
  return {
    x: client.x - BORDER_PX,
    y: client.y - BORDER_PX,
    width: client.width + BORDER_PX * 2,
    height: client.height + BORDER_PX * 2,
  };
}

export const WINDOW_MANAGER = new WindowManager(naturalRootRect);
const HOT_RELOAD_STATE_KEY = "config.window-manager";
const TILING_IPC = startTilingIpc(WINDOW_MANAGER);

COMPOSITOR.onDisable((event) => {
  TILING_IPC.close();
  if (event.isReloading) {
    event.persist(HOT_RELOAD_STATE_KEY, WINDOW_MANAGER.snapshot());
  }
});

COMPOSITOR.onEnable((event) => {
  if (event.isReloading) {
    const snapshot = event.restore<
      ReturnType<typeof WINDOW_MANAGER.snapshot>
    >(HOT_RELOAD_STATE_KEY);
    if (snapshot) {
      WINDOW_MANAGER.restore(snapshot);
    }
  }
});

// ========
// INPUT
// ========
COMPOSITOR.input.configure((input) => {
  input.global = {
    keyboard: {
      layout: "us",
    },
    pointer: {
      pointerAccel: 0,
      accelProfile: "flat",
    },
    touchpad: {
      naturalScroll: true,
      disableWhileTyping: true,
      tapToClick: true,
      scrollFactor: 1.0,
      scrollMethod: HOSTNAME === "hq9afk-letsnote" ? "none" : "twoFinger",
    },
  };
});

// ===========
// KEYBINDINGS
// ===========

function notify(text: string) {
  COMPOSITOR.process.spawn({ command: ["notify-send", "-t", "1500", text] });
}

// keqing-shell
COMPOSITOR.key.bind("shell-control", mod("C", "s"), () => {
  COMPOSITOR.process.spawn({ command: SHELL.control });
});
COMPOSITOR.key.bind("shell-settings", mod("I"), () => {
  COMPOSITOR.process.spawn({ command: SHELL.settings });
});
COMPOSITOR.key.bind("shell-lock", mod("L"), () => {
  COMPOSITOR.process.spawn({ command: SHELL.lock });
});
COMPOSITOR.key.bind("shell-matrix", mod("M"), () => {
  COMPOSITOR.process.spawn({ command: SHELL.matrix });
});
COMPOSITOR.key.bind("shell-logout", mod("Q"), () => {
  COMPOSITOR.process.spawn({ command: SHELL.logout });
});
COMPOSITOR.key.bind("shell-visualizer", mod("V", "s"), () => {
  COMPOSITOR.process.spawn({ command: SHELL.visualizer });
});
COMPOSITOR.key.bind("shell-overview", mod("Tab"), () => {
  COMPOSITOR.process.spawn({ command: SHELL.overview });
});
COMPOSITOR.key.bind("shell-launcher", "Shift+space", () => {
  COMPOSITOR.process.spawn({ command: SHELL.launcher });
});

// Window states
COMPOSITOR.key.bind("window-fullscreen-toggle", mod("F", "s"), () => {
  WINDOW_MANAGER.toggleFocusedWindowFullscreen();
});

COMPOSITOR.key.bind("window-float-toggle", mod("V"), () => {
  WINDOW_MANAGER.toggleFocusedWindowFloat();
});

// Apps
COMPOSITOR.key.bind("app-browser", mod("B"), () => {
  COMPOSITOR.process.spawn({ command: APP.browser });
});
COMPOSITOR.key.bind("app-browser-private", mod("B", "s"), () => {
  COMPOSITOR.process.spawn({ command: APP.browserPrivate });
});
COMPOSITOR.key.bind("app-editor", mod("C"), () => {
  COMPOSITOR.process.spawn({ command: APP.editor });
});
COMPOSITOR.key.bind("app-filemanager", mod("E"), () => {
  COMPOSITOR.process.spawn({ command: APP.fileManager });
});
COMPOSITOR.key.bind("app-editor-shell-repo", mod("K", "a"), () => {
  COMPOSITOR.process.spawn({ command: `${APP.editor} keqing-shell` });
});
COMPOSITOR.key.bind("app-editor-dots-repo", mod("K", "s"), () => {
  COMPOSITOR.process.spawn({ command: `${APP.editor} keqing-dots` });
});
COMPOSITOR.key.bind("app-screenshot", mod("S", "s"), () => {
  COMPOSITOR.process.spawn({ command: APP.screenshot });
});
COMPOSITOR.key.bind("app-terminal", mod("T"), () => {
  COMPOSITOR.process.spawn({ command: APP.terminal });
});

// Window operations.
// Column layout is horizontal-only, so — unlike Hyprland, where every direction
// goes through the same adaptive-move-or-switch-monitor dispatcher — vertical
// focus/move maps to workspace switching instead of a tile axis that doesn't
// exist here.
COMPOSITOR.key.bind("tile-focus-left", mod("Left"), () => {
  WINDOW_MANAGER.focusTile(-1);
});
COMPOSITOR.key.bind("tile-focus-right", mod("Right"), () => {
  WINDOW_MANAGER.focusTile(1);
});
COMPOSITOR.key.bind("workspace-focus-prev", mod("Up"), () => {
  WINDOW_MANAGER.switchWorkspace(-1);
});
COMPOSITOR.key.bind("workspace-focus-next", mod("Down"), () => {
  WINDOW_MANAGER.switchWorkspace(1);
});
COMPOSITOR.key.bind("tile-move-left", mod("Left", "s"), () => {
  WINDOW_MANAGER.moveFocusedTile(-1);
});
COMPOSITOR.key.bind("tile-move-right", mod("Right", "s"), () => {
  WINDOW_MANAGER.moveFocusedTile(1);
});
COMPOSITOR.key.bind("window-move-workspace-prev", mod("Up", "s"), () => {
  WINDOW_MANAGER.moveFocusedWindowToWorkspace(-1);
});
COMPOSITOR.key.bind("window-move-workspace-next", mod("Down", "s"), () => {
  WINDOW_MANAGER.moveFocusedWindowToWorkspace(1);
});
COMPOSITOR.key.bind("close-focused-window", mod("W"), () => {
  WINDOW_MANAGER.closeFocusedWindow();
});

// Workspace operations: for i in 1..WORKSPACES_PER_MONITOR, local workspace
// number i is bound to key (i % WORKSPACES_PER_MONITOR) — "1".."9" then "0"
// for the 10th.
for (let i = 1; i <= WORKSPACES_PER_MONITOR; i++) {
  const key = String(i % WORKSPACES_PER_MONITOR);
  COMPOSITOR.key.bind(`workspace-focus-${i}`, mod(key), () => {
    WINDOW_MANAGER.switchWorkspaceTo(
      WINDOW_MANAGER.getCurrentMonitorName(),
      i,
    );
  });
  COMPOSITOR.key.bind(`workspace-swap-${i}`, mod(key, "c"), () => {
    WINDOW_MANAGER.swapActiveWorkspaceWith(i);
  });
  COMPOSITOR.key.bind(`workspace-move-window-${i}`, mod(key, "s"), () => {
    WINDOW_MANAGER.moveFocusedWindowToWorkspaceIndex(i);
  });
}

// Media keys. [DROP-behavior]: Hyprland's `locked = true` lets
// these fire while the screen is locked; ShojiWM's key.bind has no such
// override (session-lock input goes straight to the lock surface before
// runtime key bindings are even matched), so volume/brightness keys will not
// work while keqing-shell's lock screen is active. Known regression.
COMPOSITOR.key.bind("volume-down", "XF86AudioLowerVolume", () => {
  COMPOSITOR.process.spawn({
    command: ["wpctl", "set-volume", "@DEFAULT_AUDIO_SINK@", "1%-"],
  });
});
COMPOSITOR.key.bind("mic-mute-toggle", "XF86AudioMicMute", () => {
  COMPOSITOR.process.spawn({
    command: ["wpctl", "set-mute", "@DEFAULT_AUDIO_SOURCE@", "toggle"],
  });
});
COMPOSITOR.key.bind("mute-toggle", "XF86AudioMute", () => {
  COMPOSITOR.process.spawn({
    command: ["wpctl", "set-mute", "@DEFAULT_AUDIO_SINK@", "toggle"],
  });
});
COMPOSITOR.key.bind("volume-up", "XF86AudioRaiseVolume", () => {
  COMPOSITOR.process.spawn({
    command: ["wpctl", "set-volume", "-l", "1", "@DEFAULT_AUDIO_SINK@", "1%+"],
  });
});
COMPOSITOR.key.bind("brightness-down", "XF86MonBrightnessDown", () => {
  COMPOSITOR.process.spawn({
    command: ["brightnessctl", "-e4", "-n2", "set", "1%-"],
  });
});
COMPOSITOR.key.bind("brightness-up", "XF86MonBrightnessUp", () => {
  COMPOSITOR.process.spawn({
    command: ["brightnessctl", "-e4", "-n2", "set", "1%+"],
  });
});

// Mouse
COMPOSITOR.pointer.bindWindowMoveModifier("Super");
COMPOSITOR.pointer.bindWindowResizeModifier("Super");

// Column count / strict mode / reset / monocle.
// Column counts are configured per device (see devices/hq9afk-letsnote.ts).
function columnsWorkspaceLabel(): string {
  const workspace = WINDOW_MANAGER.getCurrentWorkspace();
  return workspace ? `${workspace.monitor}:${workspace.index}` : "?";
}
COMPOSITOR.key.bind("columns-up", mod("equal"), () => {
  const columns = WINDOW_MANAGER.bumpColumns(1);
  if (columns !== undefined) {
    notify(`Workspace: ${columnsWorkspaceLabel()}\nColumns: ${columns}`);
  }
});
COMPOSITOR.key.bind("columns-down", mod("minus"), () => {
  const columns = WINDOW_MANAGER.bumpColumns(-1);
  if (columns !== undefined) {
    notify(`Workspace: ${columnsWorkspaceLabel()}\nColumns: ${columns}`);
  }
});
COMPOSITOR.key.bind("columns-strict-toggle", mod("equal", "s"), () => {
  const strict = WINDOW_MANAGER.toggleStrictColumns();
  if (strict !== undefined) {
    notify(
      `Workspace: ${columnsWorkspaceLabel()}\nStrict Columns: ${strict ? "On" : "Off"}`,
    );
  }
});
COMPOSITOR.key.bind("columns-reset", mod("minus", "s"), () => {
  WINDOW_MANAGER.resetColumnLayout();
  notify(`Workspace: ${columnsWorkspaceLabel()}\nReset to defaults`);
});
COMPOSITOR.key.bind("toggle-monocle-or-maximize", mod("F"), () => {
  WINDOW_MANAGER.toggleMonocleOrMaximize();
});

// ============
// DECORATION
// ============
// Hyprland's general/decoration block (border, gaps, rounding, opacity) has
// no config-level equivalent — it's per-window here, read directly instead
// of via a separate window-rule list.
const FULLSCREEN_Z_INDEX = 2_000_000_000;

COMPOSITOR.window.composition = (window: WaylandWindow) => {
  const workspaceOffsetY = window.state[WINDOW_STATE_WORKSPACE_OFFSET_Y];
  const workspaceOpacity = window.state[WINDOW_STATE_WORKSPACE_OPACITY];
  const tileDragging = window.state[WINDOW_STATE_TILE_DRAGGING];
  const workspaceVisible = window.state[WINDOW_STATE_WORKSPACE_VISIBLE];
  const minimizeVisualIdle = window.state[WINDOW_STATE_MINIMIZE_VISUAL_IDLE];

  const managedRect = computed(() => {
    const rect = window.state[WINDOW_STATE_RECT]();
    return {
      x: read(rect.x),
      y: read(rect.y) + workspaceOffsetY(),
      width: read(rect.width),
      height: read(rect.height),
    };
  });
  const forceRectSize = computed(
    () => window.isResizable() && !window.isTransient(),
  );
  const tiled = computed(() => window.state[WINDOW_STATE_TILED]());
  const inactive = computed(
    () => minimizeVisualIdle() || (!workspaceVisible() && !tileDragging()),
  );

  // hl.window_rule({match={class="code-oss"}, opacity="0.7"})
  const isCodeOss = (window.appId() ?? "").toLowerCase() === "code-oss";
  const opacity = computed(
    () => read(workspaceOpacity) * (isCodeOss ? 0.7 : 1),
  );

  // Fullscreen: drop all chrome and let the client fill its managed rect
  // edge to edge — also what promotes the client buffer to direct scanout.
  if (window.state[WINDOW_STATE_FULLSCREEN]()) {
    return (
      <ManagedWindow
        rect={managedRect}
        zIndex={FULLSCREEN_Z_INDEX}
        visibleOutputs={window.state[WINDOW_STATE_VISIBLE_OUTPUTS]}
        opacity={opacity}
        forceRectSize={forceRectSize}
        tiled={tiled}
        idle={inactive}
        interactive={inactive((value) => !value)}
        allowTearing={true}
      >
        <ClientWindow />
      </ManagedWindow>
    );
  }

  // hl.window_rule float/general.col: floating windows get a fixed border
  // color regardless of focus; tiled windows use the focus-based scheme.
  const borderColor = computed(() => {
    if (!window.state[WINDOW_STATE_TILED]()) {
      return COL.text;
    }
    return read(window.isFocused) ? COL.accent : `${COL.textDim}AA`;
  });

  return (
    <ManagedWindow
      rect={managedRect}
      zIndex={WINDOW_MANAGER.getWindowZIndex(window)}
      visibleOutputs={window.state[WINDOW_STATE_VISIBLE_OUTPUTS]}
      opacity={opacity}
      forceRectSize={forceRectSize}
      tiled={tiled}
      idle={inactive}
      interactive={inactive((value) => !value)}
    >
      <WindowBorder
        style={{
          border: { px: BORDER_PX, color: borderColor },
          borderRadius: 10,
          background: "#00000000",
        }}
        interaction={{ resizeHitArea: { edgePx: 8, cornerPx: 14 } }}
      >
        <ClientWindow />
      </WindowBorder>
    </ManagedWindow>
  );
};

// ==================
// EVENT WIRING
// ==================
COMPOSITOR.event.onOpen((window) => {
  WINDOW_MANAGER.onOpen(window);
});

COMPOSITOR.event.onFirstCommit((window) => {
  WINDOW_MANAGER.onFirstCommit(window);
});

COMPOSITOR.event.onStartClose((window) => {
  WINDOW_MANAGER.onStartClose(window);
});

COMPOSITOR.event.onClose((window) => {
  WINDOW_MANAGER.onClose(window);
});

COMPOSITOR.event.onFocus((window, focused) => {
  WINDOW_MANAGER.onFocus(window, focused);
  if (focused) {
    WINDOW_MANAGER.recordFocus(window.id);
  }
});

COMPOSITOR.event.onPointerMoveAsync((event) => {
  WINDOW_MANAGER.onPointerMove(event);
});

COMPOSITOR.event.onOutputChange((event) => {
  WINDOW_MANAGER.onOutputChange(event);
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
});

// ======
// DEVICE
// ======
// Always last — reads /etc/hostname and loads the matching file under
// devices/, which registers this machine's outputs, column
// count, and autostart commands.
loadDevice();

export default COMPOSITOR;
