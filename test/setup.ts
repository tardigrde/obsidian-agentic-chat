// Production runs in Obsidian's renderer. Mirror its Window-backed web globals
// while keeping the fast Node test environment.
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: globalThis,
});
