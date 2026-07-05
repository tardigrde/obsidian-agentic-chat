import { env } from "process";
import { config as baseConfig } from "./wdio.conf.mts";

type ObsidianCapability = WebdriverIO.Capabilities & {
  "wdio:obsidianOptions"?: Record<string, unknown>;
};

const targetVault = env.TARGET_VAULT?.trim();
if (!targetVault) {
  throw new Error("TARGET_VAULT must point at the Obsidian vault to dogfood. Use `npm run test:e2e:dogfood` for the generated-vault target.");
}

const copyVault = env.DOGFOOD_COPY !== "false";
const dogfoodSpec = env.DOGFOOD_SPEC?.trim() || "./test/e2e/dogfood/next-level.dogfood.ts";
const timeoutMs = Number(env.DOGFOOD_TIMEOUT_MS || 10 * 60 * 1000);

export const config: WebdriverIO.Config = {
  ...baseConfig,
  specs: [dogfoodSpec],
  exclude: [],
  maxInstances: 1,
  capabilities: ((baseConfig.capabilities ?? []) as ObsidianCapability[]).map((capability) => {
    const obsidianOptions = capability["wdio:obsidianOptions"] ?? {};
    return {
      ...capability,
      "wdio:obsidianOptions": {
        ...obsidianOptions,
        vault: targetVault,
        copy: copyVault,
        plugins: ["."],
      },
    };
  }),
  mochaOpts: {
    ...baseConfig.mochaOpts,
    timeout: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10 * 60 * 1000,
  },
};
