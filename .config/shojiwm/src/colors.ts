// COLORS
// Reads the *live* theme palette from ~/.config/keqing-shell/colors.json (the
// "current" theme object) at module load, so borders/accents stay in sync
// with whatever theme keqing-shell currently has active. Falls back to a
// hardcoded dark-purple palette if the file or a given key is missing.
// Ported from utils/colors.lua.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";

export interface ColorPalette {
  base: string;
  surface: string;
  surfaceAlt: string;
  accentAltContainer: string;
  accentContainer: string;
  lavender: string;
  textDim: string;
  rose: string;
  textMuted: string;
  fieldBg: string;
  overlay: string;
  overlayAlt: string;
  accentAlt: string;
  accentDim: string;
  accent: string;
  lavenderLight: string;
  text: string;
}

const DEFAULTS: ColorPalette = {
  // dark range (color0-7)
  base: "#0A0614",
  surface: "#110B22",
  surfaceAlt: "#1A1238",
  accentAltContainer: "#2B1D5C",
  accentContainer: "#3D1878",
  lavender: "#5E50A0",
  textDim: "#5E50A0",
  rose: "#7A4A58",
  textMuted: "#A896C8",
  // bright range (color8-15)
  fieldBg: "#0F1535",
  overlay: "#1C1848",
  overlayAlt: "#252060",
  accentAlt: "#C8942A",
  accentDim: "#5535B8",
  accent: "#7B2FE8",
  lavenderLight: "#C87EFF",
  text: "#F0ECF8",
};

function loadCurrentTheme(): Partial<ColorPalette> {
  try {
    const raw = readFileSync(
      `${homedir()}/.config/keqing-shell/colors.json`,
      "utf-8",
    );
    const current = JSON.parse(raw)?.current;
    return current && typeof current === "object" ? current : {};
  } catch {
    return {};
  }
}

export const colors: ColorPalette = { ...DEFAULTS, ...loadCurrentTheme() };
