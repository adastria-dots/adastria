// Augments ShojiWM's own node-compat.d.ts (which only declares the Node
// builtins the stock runtime uses internally) with the extra bits
// theme-colors.ts needs to read ~/.config/keqing-shell/colors.json. The
// runtime is plain Node (via tsx), so these all work; only the ambient
// types are missing upstream.
declare module "node:fs" {
  export function readFileSync(path: string, encoding: string): string;
}

declare module "node:os" {
  export function homedir(): string;
}

declare module "node:path" {
  export function join(...paths: string[]): string;
}
