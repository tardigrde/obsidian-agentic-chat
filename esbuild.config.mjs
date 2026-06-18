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
const piAiProviderPath = fileURLToPath(import.meta.resolve("@earendil-works/pi-ai/openai-completions"));
const piAiDistDir = path.dirname(path.dirname(piAiProviderPath));

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
        export { getModels } from ${JSON.stringify(path.join(piAiDistDir, "models.js"))};
        export {
          EventStream,
          AssistantMessageEventStream,
          createAssistantMessageEventStream
        } from ${JSON.stringify(path.join(piAiDistDir, "utils/event-stream.js"))};
        export { parseStreamingJson } from ${JSON.stringify(path.join(piAiDistDir, "utils/json-parse.js"))};
        export { validateToolArguments } from ${JSON.stringify(path.join(piAiDistDir, "utils/validation.js"))};
        import {
          streamOpenAICompletions,
          streamSimpleOpenAICompletions
        } from ${JSON.stringify(piAiProviderPath)};
        export const stream = streamOpenAICompletions;
        export const streamSimple = streamSimpleOpenAICompletions;
        export async function complete(model, context, options) {
          return streamOpenAICompletions(model, context, options).result();
        }
        export async function completeSimple(model, context, options) {
          return streamSimpleOpenAICompletions(model, context, options).result();
        }
      `,
    }));
  },
};

const context = await esbuild.context({
  banner: { js: banner },
  entryPoints: ["src/main.ts"],
  bundle: true,
  plugins: [piAiMobileEntry],
  external: [
    "obsidian",
    "electron",
    "@codemirror/*",
    "@lezer/*",
  ],
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  legalComments: production ? "eof" : "inline",
  minify: production,
  sourcemap: production ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
});

if (production) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
