import { installOfflineGuard } from "./support/offline-guard";

// Production runs in Obsidian's renderer. Mirror its Window-backed web globals
// for modules that still call window (for example subagent timers); the semantic
// index now takes an injected lease timer instead.
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: globalThis,
});

// T1 is hermetic: a remote call fails instead of reaching the network.
installOfflineGuard();
