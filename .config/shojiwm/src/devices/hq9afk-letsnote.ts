// DEVICE: hq9afk-letsnote (laptop)
// Currently running as the ShojiWM guinea pig — bare ShojiWM+SDDM install,
// no prior config. Becomes the daily-driver again once this port is proven
// (see local/implementation_plan.md). Ported from devices/hq9afk-letsnote.lua.

import { COMPOSITOR, type DisplayConfigDraft } from "shoji_wm";
import { HYBRID_WINDOW_MANAGER } from "../index";

COMPOSITOR.output.configure(() => {
  const display: DisplayConfigDraft = {};

  display["eDP-1"] = {
    mode: "extend",
    resolution: "best",
    position: { x: 0, y: 0 },
  };

  // External monitor mirrors the laptop panel when connected, matching
  // hl.monitor({output = "DP-2", mirror = "eDP-1"}) in the Hyprland config.
  display["DP-2"] = { mode: "mirror", source: "eDP-1" };

  return display;
});

// scrollumns: 2 columns on this device (L.register(2) in the Hyprland config).
HYBRID_WINDOW_MANAGER.configureScrollumns(2);

COMPOSITOR.process.once("fcitx5", {
  command: "fcitx5 -d",
  runPolicy: "once-per-session",
});
COMPOSITOR.process.once("keqing-shell", {
  command: "keqing-shell",
  runPolicy: "once-per-session",
});
