/**
 * The one place the plugin reaches Node/Electron modules. Obsidian desktop
 * exposes `require` on the window; mobile has none, so every caller must treat
 * `undefined` as "desktop-only feature unavailable".
 */
export type NodeRequire = (moduleName: string) => unknown;

export function optionalNodeRequire(): NodeRequire | undefined {
  const candidate = typeof window === "undefined" ? undefined : (window as { require?: unknown }).require;
  if (typeof candidate === "function") return candidate as NodeRequire;
  return typeof require === "function" ? require : undefined;
}
