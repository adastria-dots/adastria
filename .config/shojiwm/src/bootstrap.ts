// BOOTSTRAP
// Shared helper library every other file imports from. Ported from
// utils/bootstrap.lua.

import { readFileSync } from "node:fs";
import { COMPOSITOR } from "shoji_wm";

// devices/hq9afk.ts doesn't exist yet — hq9afk (this desktop) intentionally
// stays on Hyprland until ShojiWM is proven on hq9afk-letsnote (see
// local/implementation_plan.md). Add an entry here once it's ported.
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

// Read once at module load — used both to pick the device file below and by
// index.tsx for the one input setting (touchpad scroll method) that varies
// per machine but isn't tied to a specific named input device.
export const HOSTNAME = readHostname();

// Reads /etc/hostname and dynamically imports the matching file under
// devices/, same "import by name" pattern as B.load_device().
export async function loadDevice() {
  const device = DEVICES[HOSTNAME] ?? DEFAULT_DEVICE;
  return import(`./devices/${device}.ts`);
}

// Builds a ShojiWM shortcut string from a short mod-letter code, e.g.
// mod("F", "s") -> "Super+Shift+F" (c=Ctrl, a=Alt, s=Shift, Super always
// included). Mirrors B.mod, adapted to ShojiWM's "Super+Shift+F" syntax
// (no spaces, mixed case) instead of Hyprland's "SUPER + SHIFT + F".
export function mod(key: string, mods = ""): string {
  const parts = ["Super"];
  if (mods.includes("c")) parts.push("Ctrl");
  if (mods.includes("a")) parts.push("Alt");
  if (mods.includes("s")) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}

const REPEAT_INITIAL_DELAY_MS = 400;
const REPEAT_INTERVAL_MS = 150;

// ShojiWM's key.bind has no Hyprland-style `repeating` option: each physical
// press yields exactly one Press event (no held-state concept in the runtime
// key-binding matcher). Wrap the action in a timer instead: fire once on
// press, then keep firing on an interval until release. See
// local/implementation_plan.md §6 for the underlying Rust-side constraint.
export function bindRepeating(id: string, shortcut: string, action: () => void) {
  let timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval> | null = null;

  COMPOSITOR.key.bind(id, shortcut, () => {
    action();
    timer = setTimeout(() => {
      timer = setInterval(action, REPEAT_INTERVAL_MS);
    }, REPEAT_INITIAL_DELAY_MS);
  });

  COMPOSITOR.key.bind(
    `${id}-release`,
    shortcut,
    () => {
      if (timer) {
        clearTimeout(timer as ReturnType<typeof setTimeout>);
        clearInterval(timer as ReturnType<typeof setInterval>);
        timer = null;
      }
    },
    { on: "release" },
  );
}
