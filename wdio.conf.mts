import * as path from "path";
import { parseObsidianVersions } from "wdio-obsidian-service";
import { env } from "process";
import { collectE2EFailureArtifacts } from "./test/e2e/support/failure-artifacts";

// wdio-obsidian-service downloads + sandboxes Obsidian builds into this directory.
const cacheDir = path.resolve(".obsidian-cache");
const externalChromedriverPort = env.WDIO_EXTERNAL_CHROMEDRIVER_PORT
  ? Number(env.WDIO_EXTERNAL_CHROMEDRIVER_PORT)
  : undefined;
const mobileViewport = env.AGENTIC_CHAT_E2E_MOBILE_VIEWPORT === "1";
const mobileViewportWidth = Number(env.AGENTIC_CHAT_E2E_VIEWPORT_WIDTH || 390);
const mobileViewportHeight = Number(env.AGENTIC_CHAT_E2E_VIEWPORT_HEIGHT || 844);

if (externalChromedriverPort !== undefined && !Number.isInteger(externalChromedriverPort)) {
  throw new Error(`WDIO_EXTERNAL_CHROMEDRIVER_PORT must be an integer, got ${env.WDIO_EXTERNAL_CHROMEDRIVER_PORT}`);
}

function localDriverEnv(): NodeJS.ProcessEnv {
  const driverEnv: NodeJS.ProcessEnv = {
    ...env,
    NO_PROXY: "localhost,127.0.0.1,::1",
    no_proxy: "localhost,127.0.0.1,::1",
    NODE_OPTIONS: "",
  };

  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
    delete driverEnv[key];
  }

  return driverEnv;
}

function obsidianProxyArgs(): string[] {
  const proxyServer = normalizeProxyServer(
    env.AGENTIC_CHAT_E2E_PROXY_SERVER ??
      env.OBSIDIAN_PROXY_SERVER ??
      env.HTTPS_PROXY ??
      env.HTTP_PROXY ??
      env.https_proxy ??
      env.http_proxy,
  );
  if (!proxyServer) return [];
  const bypassList = env.AGENTIC_CHAT_E2E_PROXY_BYPASS_LIST ?? env.OBSIDIAN_PROXY_BYPASS_LIST ?? "localhost;127.0.0.1;::1;<local>";
  return [`--proxy-server=${proxyServer}`, `--proxy-bypass-list=${bypassList}`];
}

function normalizeProxyServer(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    if (!["http:", "https:", "socks4:", "socks5:"].includes(url.protocol)) return trimmed.replace(/\/+$/, "");
    return `${url.protocol}//${url.host}`;
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

function chromedriverOptions(): NonNullable<WebdriverIO.Capabilities["wdio:chromedriverOptions"]> {
  return {
    spawnOpts: {
      // Keep WDIO's parent process proxy-aware for downloads, but keep the local
      // chromedriver/Obsidian control plane off the corporate proxy path.
      env: localDriverEnv(),
    },
  } as unknown as NonNullable<WebdriverIO.Capabilities["wdio:chromedriverOptions"]>;
}

function viewportArgs(): string[] {
  if (!mobileViewport) return [];
  if (!Number.isInteger(mobileViewportWidth) || !Number.isInteger(mobileViewportHeight)) {
    throw new Error("AGENTIC_CHAT_E2E_VIEWPORT_WIDTH and AGENTIC_CHAT_E2E_VIEWPORT_HEIGHT must be integers.");
  }
  return [
    `--window-size=${mobileViewportWidth},${mobileViewportHeight}`,
    "--force-device-scale-factor=1",
    "--touch-events=enabled",
  ];
}

// Local default: one latest desktop build. The fixed-port runner supports one
// Obsidian version pair per invocation; `npm run test:e2e:matrix` loops over
// supported pairs (earliest + latest by default) for broader coverage.
const versions = await parseObsidianVersions(env.OBSIDIAN_VERSIONS ?? "latest/latest", { cacheDir });

// Base, local-only e2e config (D1). It boots Obsidian Desktop through Electron.
// `AGENTIC_CHAT_E2E_MOBILE_VIEWPORT=1` narrows that desktop runtime to a
// phone-sized viewport for layout/touch-path smoke tests; real Obsidian Mobile
// still needs the manual/ADB checklist in MOBILE_TESTING.md.
export const config: WebdriverIO.Config = {
  runner: "local",
  framework: "mocha",
  ...(externalChromedriverPort
    ? {
        hostname: env.WDIO_EXTERNAL_CHROMEDRIVER_HOST ?? "127.0.0.1",
        port: externalChromedriverPort,
      }
    : {}),

  specs: mobileViewport
    ? ["./test/e2e/specs/mobile-viewport.e2e.ts"]
    : ["./test/e2e/specs/**/*.e2e.ts"],
  exclude: mobileViewport ? [] : ["./test/e2e/specs/mobile-viewport.e2e.ts"],

  // One Obsidian instance at a time keeps a local run simple and quiet.
  maxInstances: Number(env.WDIO_MAX_INSTANCES || 1),

  capabilities: versions.map<WebdriverIO.Capabilities>(([appVersion, installerVersion]) => ({
    browserName: "obsidian",
    "wdio:obsidianOptions": {
      appVersion,
      installerVersion,
      emulateMobile: mobileViewport,
      // Load this repo's built plugin (needs `npm run build` first — `pretest:e2e` does it).
      plugins: ["."],
      // The service copies this into a throwaway sandbox per run — a fresh tmp vault.
      vault: "test/e2e/vault",
    },
    "goog:chromeOptions": {
      ...(mobileViewport
        ? {
            mobileEmulation: {
              deviceMetrics: {
                width: mobileViewportWidth,
                height: mobileViewportHeight,
                pixelRatio: 1,
              },
            },
          }
        : {}),
      args: [
        // WSL can expose IPv6 loopback oddly; force Obsidian's DevTools endpoint
        // onto IPv4 so chromedriver does not exit with "IPv6 port not available".
        "--remote-debugging-address=127.0.0.1",
        ...obsidianProxyArgs(),
        ...viewportArgs(),
      ],
    },
    "wdio:chromedriverOptions": chromedriverOptions(),
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

  afterTest: async (test, _context, result) => {
    await collectE2EFailureArtifacts({
      test,
      result,
      artifactsRoot: path.resolve("logs/e2e-artifacts"),
    });
  },

  // Import describe/it/expect explicitly in specs (keeps the lint/types honest).
  injectGlobals: false,
};
