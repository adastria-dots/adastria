// VARIABLES

import { homedir } from "node:os";
import { colors } from "./colors";

export const COL = colors;

export const HOME = homedir();
export const ROOT = `${HOME}/keqing-dots`;
export const WORKSPACES_PER_MONITOR = 10;

export const APP = {
  terminal: "kitty",
  browser: "zen-browser",
  browserPrivate: "zen-browser --private",
  editor: "code",
  fileManager: "kitty yazi",
  screenshot:
    "bash -c 'mkdir -p $HOME/Pictures/screenshots/ && hyprshot -m region -o $HOME/Pictures/screenshots/'",
};

// keqing-shell IPC calls
const QS = "keqing-shell ";
export const SHELL = {
  control: `${QS}controlcenter`,
  launcher: `${QS}launcher`,
  lock: `${QS}lock`,
  logout: `${QS}logout`,
  matrix: `${QS}matrix`,
  overview: `${QS}overview`,
  settings: `${QS}settings`,
  visualizer: `${QS}visualizer`,
};
