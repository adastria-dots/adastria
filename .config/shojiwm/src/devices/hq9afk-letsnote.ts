// DEVICE: hq9afk-letsnote (laptop)
// Currently running as the ShojiWM guinea pig — bare ShojiWM+SDDM install,
// no prior config. Becomes the daily-driver again once this port is proven.

import { COMPOSITOR, type DisplayConfigDraft } from "shoji_wm";
import { WINDOW_MANAGER } from "../index";

COMPOSITOR.output.configure(() => {
  const display: DisplayConfigDraft = {};

  display["eDP-1"] = {
    mode: "extend",
    resolution: "best",
    position: { x: 0, y: 0 },
  };

  // External monitor mirrors the laptop panel when connected.
  display["DP-2"] = { mode: "mirror", source: "eDP-1" };

  return display;
});

// 2 columns on this device.
WINDOW_MANAGER.configureColumns(2);

COMPOSITOR.process.once("fcitx5", {
  command: "fcitx5 -d",
  runPolicy: "once-per-session",
});
COMPOSITOR.process.once("keqing-shell", {
  command: "keqing-shell",
  runPolicy: "once-per-session",
});
