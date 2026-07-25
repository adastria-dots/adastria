// BOOTSTRAP

import { readFileSync } from "node:fs";

const DEVICES: Record<string, string> = {
  "hq9afk-letsnote": "hq9afk-letsnote",
};
const DEFAULT_DEVICE = "hq9afk-letsnote";

function readHostname(): string {
  try {
    return readFileSync("/etc/hostname", "utf-8").trim() || DEFAULT_DEVICE;
  } catch {
    return DEFAULT_DEVICE;
  }
}

export const HOSTNAME = readHostname();

export async function loadDevice() {
  const device = DEVICES[HOSTNAME] ?? DEFAULT_DEVICE;
  return import(`../devices/${device}.ts`);
}

export function mod(key: string, mods = ""): string {
  const parts = ["Super"];
  if (mods.includes("c")) parts.push("Ctrl");
  if (mods.includes("a")) parts.push("Alt");
  if (mods.includes("s")) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}
