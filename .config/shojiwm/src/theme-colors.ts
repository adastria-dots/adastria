import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ThemeColors {
  accent: string;
  lavender: string;
  textDim: string;
}

const FALLBACK: ThemeColors = {
  accent: "#7B2FE8",
  lavender: "#5E50A0",
  textDim: "#5E50A0",
};

function readCurrentTheme(): Record<string, string> {
  try {
    const path = join(homedir(), ".config/keqing-shell/colors.json");
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed.current ?? {};
  } catch {
    return {};
  }
}

const current = readCurrentTheme();

// Same source + same fallback hexes as .config/hypr/utils/colors.lua, so
// ShojiWM and Hyprland degrade identically if the file is missing.
export const theme: ThemeColors = {
  accent: current.accent ?? FALLBACK.accent,
  lavender: current.lavender ?? FALLBACK.lavender,
  // colors.lua's textDim reads the `lavender` key too (not `textDim`) —
  // mirrored here rather than "fixed" so both configs stay in sync.
  textDim: current.lavender ?? FALLBACK.textDim,
};
