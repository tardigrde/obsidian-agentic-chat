import * as path from "path";
import { parseObsidianVersions } from "wdio-obsidian-service";
import { env } from "process";

// wdio-obsidian-service downloads + sandboxes Obsidian builds into this directory.
const cacheDir = path.resolve(".obsidian-cache");

// Local default: just the latest desktop build, for a fast smoke. Widen the matrix
// with OBSIDIAN_VERSIONS (e.g. "earliest/earliest latest/latest") when you want it.
const versions = await parseObsidianVersions(env.OBSIDIAN_VERSIONS ?? "latest/latest", { cacheDir });

// Base, local-only e2e config (D1). Desktop only — the plugin is also mobile-safe, but
// the emulate-mobile / Android matrix is intentionally left out of this base infra. It is
// NOT wired into CI: it boots a real Obsidian (Electron) instance, which needs a display.
export const config: WebdriverIO.Config = {
  runner: "local",
  framework: "mocha",

  specs: ["./test/e2e/specs/**/*.e2e.ts"],

  // One Obsidian instance at a time keeps a local run simple and quiet.
  maxInstances: Number(env.WDIO_MAX_INSTANCES || 1),

  capabilities: versions.map<WebdriverIO.Capabilities>(([appVersion, installerVersion]) => ({
    browserName: "obsidian",
    "wdio:obsidianOptions": {
      appVersion,
      installerVersion,
      // Load this repo's built plugin (needs `npm run build` first — `pretest:e2e` does it).
      plugins: ["."],
      // The service copies this into a throwaway sandbox per run — a fresh tmp vault.
      vault: "test/e2e/vault",
    },
  })),

  services: ["obsidian"],
  // Wrapper around spec-reporter that prints the Obsidian version under test.
  reporters: ["obsidian"],

  mochaOpts: {
    ui: "bdd",
    timeout: 60 * 1000,
  },
  waitforInterval: 250,
  waitforTimeout: 5 * 1000,
  logLevel: "warn",

  cacheDir,

  // Import describe/it/expect explicitly in specs (keeps the lint/types honest).
  injectGlobals: false,
};
