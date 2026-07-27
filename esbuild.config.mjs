import esbuild from "esbuild";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const banner = `/*
Bundled build of the Agentic Chat plugin.
Sources: https://github.com/tardigrde/obsidian-agentic-chat
Third-party notices: https://github.com/tardigrde/obsidian-agentic-chat/blob/main/THIRD_PARTY_NOTICES.md
*/`;

const production = process.argv[2] === "production";
const outfile = process.env.AGENTIC_CHAT_OUTFILE || "main.js";
const enableE2EStream = !production || process.env.AGENTIC_CHAT_ENABLE_E2E_STREAM === "1";
const piAiProviderPath = fileURLToPath(import.meta.resolve("@earendil-works/pi-ai/api/openai-completions"));
const piAiDistDir = path.dirname(path.dirname(piAiProviderPath));
const disabledE2EStreamPath = path.join(process.cwd(), "src", "agent", "e2e-stream-disabled.ts");

/**
 * pi-agent-core imports the broad pi-ai entry point, which registers every
 * provider and probes Node.js APIs. The plugin only supports the
 * openai-completions transport, so expose a browser-safe subset at bundle time.
 */

const piAiMobileEntry = {
  name: "pi-ai-mobile-entry",
  setup(build) {
    build.onResolve({ filter: /^@earendil-works\/pi-ai$/ }, () => ({
      path: "pi-ai-mobile-entry",
      namespace: "agentic-chat",
    }));
    build.onLoad({ filter: /.*/, namespace: "agentic-chat" }, () => ({
      loader: "js",
      resolveDir: process.cwd(),
      contents: `
        export { createModels, createProvider } from ${JSON.stringify(path.join(piAiDistDir, "models.js"))};
        export {
          EventStream,
          AssistantMessageEventStream,
          createAssistantMessageEventStream
        } from ${JSON.stringify(path.join(piAiDistDir, "utils/event-stream.js"))};
        export { parseStreamingJson } from ${JSON.stringify(path.join(piAiDistDir, "utils/json-parse.js"))};
        export { validateToolArguments } from ${JSON.stringify(path.join(piAiDistDir, "utils/validation.js"))};
        export { uuidv7 } from ${JSON.stringify(path.join(piAiDistDir, "utils/uuid.js"))};
        export { contentText } from ${JSON.stringify(path.join(piAiDistDir, "utils/text.js"))};
        export { retryAssistantCall } from ${JSON.stringify(path.join(piAiDistDir, "utils/retry.js"))};
      `,
    }));
  },
};

/**
 * pi-ai's provider-env util carries a Bun sandbox fallback that requires
 * node:fs. Obsidian never runs under Bun, so substitute the browser-safe
 * override + process.env resolution and keep node:fs out of the bundle.
 */
const piAiProviderEnvStub = {
  name: "pi-ai-provider-env-stub",
  setup(build) {
    const providerEnvPath = path.join(piAiDistDir, "utils", "provider-env.js");
    build.onLoad({ filter: /utils[\\/]provider-env\.js$/ }, (args) => {
      if (path.resolve(args.path) !== path.resolve(providerEnvPath)) return undefined;
      return {
        loader: "js",
        contents: `
          export function getProviderEnvValue(name, env) {
            return env?.[name] || (typeof process !== "undefined" ? process.env[name] : undefined) || undefined;
          }
        `,
      };
    });
  },
};

const e2eStreamBuildGate = {
  name: "agentic-chat-e2e-stream-gate",
  setup(build) {
    if (enableE2EStream) return;
    build.onResolve({ filter: /^\.\/agent\/e2e-stream$/ }, (args) => {
      if (!args.importer.endsWith(path.join("src", "main.ts"))) return undefined;
      return { path: disabledE2EStreamPath };
    });
  },
};

const context = await esbuild.context({
  banner: { js: banner },
  entryPoints: ["src/main.ts"],
  bundle: true,
  plugins: [piAiMobileEntry, piAiProviderEnvStub, e2eStreamBuildGate],
  external: [
    "obsidian",
    "electron",
    "@codemirror/*",
    "@lezer/*",
  ],
  format: "cjs",
  target: "es2020",
  define: {
    __AGENTIC_CHAT_ENABLE_E2E_STREAM__: JSON.stringify(enableE2EStream),
  },
  logLevel: "info",
  legalComments: production ? "eof" : "inline",
  minify: production,
  sourcemap: production ? false : "inline",
  treeShaking: true,
  outfile,
});

if (production) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
