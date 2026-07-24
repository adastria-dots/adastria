// SHOJIWM CONFIG (keqing-dots)
// ShojiWM port of the Hyprland config under .config/hypr/. See
// local/implementation_plan.md for the full migration map — comments below
// only call out spots where behavior genuinely differs from the Lua source.

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
  HybridWindowManager,
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
import { HOSTNAME, bindRepeating, loadDevice, mod } from "./bootstrap";
import { APP, COL, ROOT, SHELL, WORKSPACES_PER_MONITOR } from "./variables";

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
// ShojiWM's cursor system is XCursor-only. An XCursor-format "Keqing" theme
// exists but installing/wiring it up is manual and deferred by the user —
// not part of this port (see local/implementation_plan.md §1).
COMPOSITOR.cursor.configure({
  theme: "Keqing",
  size: 24,
});

// ===================
// WINDOW MANAGER
// ===================
const BORDER_PX = 5; // Hyprland's general.border_size

function naturalRootRect(window: WaylandWindow): ManagedWindowRect {
  const client = window.position;
  return {
    x: client.x - BORDER_PX,
    y: client.y - BORDER_PX,
    width: client.width + BORDER_PX * 2,
    height: client.height + BORDER_PX * 2,
  };
}

export const HYBRID_WINDOW_MANAGER = new HybridWindowManager(naturalRootRect);
const HOT_RELOAD_STATE_KEY = "config.hybrid-window-manager";

COMPOSITOR.onDisable((event) => {
  if (event.isReloading) {
    event.persist(HOT_RELOAD_STATE_KEY, HYBRID_WINDOW_MANAGER.snapshot());
  }
});

COMPOSITOR.onEnable((event) => {
  if (event.isReloading) {
    const snapshot = event.restore<
      ReturnType<typeof HYBRID_WINDOW_MANAGER.snapshot>
    >(HOT_RELOAD_STATE_KEY);
    if (snapshot) {
      HYBRID_WINDOW_MANAGER.restore(snapshot);
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
      // Hyprland's input.sensitivity = 0
      pointerAccel: 0,
      accelProfile: "flat",
    },
    touchpad: {
      naturalScroll: true,
      disableWhileTyping: true,
      tapToClick: true,
      scrollFactor: 1.0,
      // hq9afk-letsnote disables touchpad scrolling entirely (Hyprland's
      // per-device `scroll_method = "no_scroll"` override in
      // devices/hq9afk-letsnote.lua); every other device keeps two-finger
      // scrolling. There's no COMPOSITOR.input.configure equivalent of
      // Hyprland's `input.follow_mouse`/`drag_lock` — dropped, no surfaced
      // field for either.
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
  HYBRID_WINDOW_MANAGER.toggleFocusedWindowFullscreen();
});
// Super+P (pseudotile) is dwindle-layout-specific — no equivalent in a
// scrolling-column layout, dropped rather than repurposed.
COMPOSITOR.key.bind("window-float-toggle", mod("V"), () => {
  HYBRID_WINDOW_MANAGER.toggleFocusedWindowFloat();
});
// Super+F is registered once below under "scrollumns", since on this device
// it's always the monocle-or-maximize rebind (layout.lua unbinds the plain
// maximize-toggle version the moment Scrollumns.register runs).

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

// Window operations (repeating, matches Hyprland's {repeating = true}).
// scrollumns is horizontal-only, so — unlike Hyprland, where every direction
// goes through the same adaptive-move-or-switch-monitor dispatcher — vertical
// focus/move maps to workspace switching instead of a tile axis that doesn't
// exist here.
bindRepeating("tile-focus-left", mod("Left"), () => {
  HYBRID_WINDOW_MANAGER.focusTile(-1);
});
bindRepeating("tile-focus-right", mod("Right"), () => {
  HYBRID_WINDOW_MANAGER.focusTile(1);
});
bindRepeating("workspace-focus-prev", mod("Up"), () => {
  HYBRID_WINDOW_MANAGER.switchWorkspace(-1);
});
bindRepeating("workspace-focus-next", mod("Down"), () => {
  HYBRID_WINDOW_MANAGER.switchWorkspace(1);
});
bindRepeating("tile-move-left", mod("Left", "s"), () => {
  HYBRID_WINDOW_MANAGER.moveFocusedTile(-1);
});
bindRepeating("tile-move-right", mod("Right", "s"), () => {
  HYBRID_WINDOW_MANAGER.moveFocusedTile(1);
});
bindRepeating("window-move-workspace-prev", mod("Up", "s"), () => {
  HYBRID_WINDOW_MANAGER.moveFocusedWindowToWorkspace(-1);
});
bindRepeating("window-move-workspace-next", mod("Down", "s"), () => {
  HYBRID_WINDOW_MANAGER.moveFocusedWindowToWorkspace(1);
});
bindRepeating("close-focused-window", mod("W"), () => {
  HYBRID_WINDOW_MANAGER.closeFocusedWindow();
});

// Workspace operations: for i in 1..WORKSPACES_PER_MONITOR, local workspace
// number i is bound to key (i % WORKSPACES_PER_MONITOR) — "1".."9" then "0"
// for the 10th. Ported from hyprland.lua's `for i = 1, V.wpm do ... end`.
for (let i = 1; i <= WORKSPACES_PER_MONITOR; i++) {
  const key = String(i % WORKSPACES_PER_MONITOR);
  COMPOSITOR.key.bind(`workspace-focus-${i}`, mod(key), () => {
    HYBRID_WINDOW_MANAGER.switchWorkspaceTo(
      HYBRID_WINDOW_MANAGER.getCurrentMonitorName(),
      i,
    );
  });
  COMPOSITOR.key.bind(`workspace-swap-${i}`, mod(key, "c"), () => {
    HYBRID_WINDOW_MANAGER.swapActiveWorkspaceWith(i);
  });
  COMPOSITOR.key.bind(`workspace-move-window-${i}`, mod(key, "s"), () => {
    HYBRID_WINDOW_MANAGER.moveFocusedWindowToWorkspaceIndex(i);
  });
}

// Media keys (repeating). [DROP-behavior]: Hyprland's `locked = true` lets
// these fire while the screen is locked; ShojiWM's key.bind has no such
// override (session-lock input goes straight to the lock surface before
// runtime key bindings are even matched), so volume/brightness keys will not
// work while keqing-shell's lock screen is active. Known regression, see
// local/implementation_plan.md §6.
bindRepeating("volume-down", "XF86AudioLowerVolume", () => {
  COMPOSITOR.process.spawn({
    command: ["wpctl", "set-volume", "@DEFAULT_AUDIO_SINK@", "1%-"],
  });
});
bindRepeating("mic-mute-toggle", "XF86AudioMicMute", () => {
  COMPOSITOR.process.spawn({
    command: ["wpctl", "set-mute", "@DEFAULT_AUDIO_SOURCE@", "toggle"],
  });
});
bindRepeating("mute-toggle", "XF86AudioMute", () => {
  COMPOSITOR.process.spawn({
    command: ["wpctl", "set-mute", "@DEFAULT_AUDIO_SINK@", "toggle"],
  });
});
bindRepeating("volume-up", "XF86AudioRaiseVolume", () => {
  COMPOSITOR.process.spawn({
    command: ["wpctl", "set-volume", "-l", "1", "@DEFAULT_AUDIO_SINK@", "1%+"],
  });
});
bindRepeating("brightness-down", "XF86MonBrightnessDown", () => {
  COMPOSITOR.process.spawn({
    command: ["brightnessctl", "-e4", "-n2", "set", "1%-"],
  });
});
bindRepeating("brightness-up", "XF86MonBrightnessUp", () => {
  COMPOSITOR.process.spawn({
    command: ["brightnessctl", "-e4", "-n2", "set", "1%+"],
  });
});

// Mouse
COMPOSITOR.pointer.bindWindowMoveModifier("Super");
COMPOSITOR.pointer.bindWindowResizeModifier("Super");

// scrollumns: column count / strict mode / reset / monocle. Repeating,
// ported from utils/layout.lua's Scrollumns.register keybinds. Column
// counts are configured per device (see devices/hq9afk-letsnote.ts).
function scrollumnsWorkspaceLabel(): string {
  const workspace = HYBRID_WINDOW_MANAGER.getCurrentWorkspace();
  return workspace ? `${workspace.monitor}:${workspace.index}` : "?";
}
bindRepeating("scrollumns-columns-up", mod("equal"), () => {
  const columns = HYBRID_WINDOW_MANAGER.bumpScrollumnsColumns(1);
  if (columns !== undefined) {
    notify(`Workspace: ${scrollumnsWorkspaceLabel()}\nColumns: ${columns}`);
  }
});
bindRepeating("scrollumns-columns-down", mod("minus"), () => {
  const columns = HYBRID_WINDOW_MANAGER.bumpScrollumnsColumns(-1);
  if (columns !== undefined) {
    notify(`Workspace: ${scrollumnsWorkspaceLabel()}\nColumns: ${columns}`);
  }
});
bindRepeating("scrollumns-strict-toggle", mod("equal", "s"), () => {
  const strict = HYBRID_WINDOW_MANAGER.toggleScrollumnsStrict();
  if (strict !== undefined) {
    notify(
      `Workspace: ${scrollumnsWorkspaceLabel()}\nStrict Columns: ${strict ? "On" : "Off"}`,
    );
  }
});
bindRepeating("scrollumns-reset", mod("minus", "s"), () => {
  HYBRID_WINDOW_MANAGER.resetScrollumnsLayout();
  notify(`Workspace: ${scrollumnsWorkspaceLabel()}\nReset to defaults`);
});
COMPOSITOR.key.bind("toggle-monocle-or-maximize", mod("F"), () => {
  HYBRID_WINDOW_MANAGER.toggleMonocleOrMaximize();
});

// ========
// GESTURES
// ========
COMPOSITOR.event.onGestureSwipeAsync((event) => {
  HYBRID_WINDOW_MANAGER.onGestureSwipe(event);
});
// [DROP] custom gesture-speed configuration — Hyprland's config doesn't set
// one either (`hl.gesture({fingers=3, ...})` has no speed knobs), so this
// relies on the stock WM's configureWorkspaceGestureSpeed defaults.

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
      zIndex={HYBRID_WINDOW_MANAGER.getWindowZIndex(window)}
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
  HYBRID_WINDOW_MANAGER.onOpen(window);
});

COMPOSITOR.event.onFirstCommit((window) => {
  HYBRID_WINDOW_MANAGER.onFirstCommit(window);
});

COMPOSITOR.event.onStartClose((window) => {
  HYBRID_WINDOW_MANAGER.onStartClose(window);
});

COMPOSITOR.event.onClose((window) => {
  HYBRID_WINDOW_MANAGER.onClose(window);
});

COMPOSITOR.event.onFocus((window, focused) => {
  HYBRID_WINDOW_MANAGER.onFocus(window, focused);
  if (focused) {
    HYBRID_WINDOW_MANAGER.recordFocus(window.id);
  }
});

COMPOSITOR.event.onPointerMoveAsync((event) => {
  HYBRID_WINDOW_MANAGER.onPointerMove(event);
});

COMPOSITOR.event.onOutputChange((event) => {
  HYBRID_WINDOW_MANAGER.onOutputChange(event);
});

COMPOSITOR.event.onCreateLayer(() => {
  HYBRID_WINDOW_MANAGER.refreshUsableAreaLayouts();
});

COMPOSITOR.event.onUpdateLayer(() => {
  HYBRID_WINDOW_MANAGER.refreshUsableAreaLayouts();
});

COMPOSITOR.event.onDestroyLayer(() => {
  HYBRID_WINDOW_MANAGER.refreshUsableAreaLayouts();
});

COMPOSITOR.event.onWindowResize((event) => {
  HYBRID_WINDOW_MANAGER.onWindowResize(event);
});

COMPOSITOR.event.onWindowMove((event) => {
  HYBRID_WINDOW_MANAGER.onWindowMove(event);
});

COMPOSITOR.event.onWindowMaximizeRequest((event) => {
  HYBRID_WINDOW_MANAGER.onWindowMaximizeRequest(event);
});

COMPOSITOR.event.onWindowMinimizeRequest((event) => {
  HYBRID_WINDOW_MANAGER.onWindowMinimizeRequest(event);
});

COMPOSITOR.event.onWindowFullscreenRequest((event) => {
  HYBRID_WINDOW_MANAGER.onWindowFullscreenRequest(event);
});

COMPOSITOR.event.onWindowActivateRequest((event) => {
  HYBRID_WINDOW_MANAGER.onWindowActivateRequest(event);
});

// ======
// DEVICE
// ======
// Always last — reads /etc/hostname and loads the matching file under
// devices/, which registers this machine's outputs, scrollumns column
// count, and autostart commands. Mirrors hyprland.lua's B.load_device().
await loadDevice();

export default COMPOSITOR;
