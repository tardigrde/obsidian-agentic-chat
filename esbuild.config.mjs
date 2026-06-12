import esbuild from "esbuild";
import process from "node:process";
import builtins from "builtin-modules";

const banner = `/*
Bundled build of the Agentic Chat plugin.
Sources: https://github.com/tardigrde/obsidian-agentic-chat
*/`;

const production = process.argv[2] === "production";

const context = await esbuild.context({
  banner: { js: banner },
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/*",
    "@lezer/*",
    // Provider SDKs pulled in by @earendil-works/pi-ai that this plugin
    // never uses (we only talk to OpenRouter via the openai-completions
    // API). pi-ai registers providers lazily, so these imports are never
    // executed at runtime; externalizing them keeps them out of the bundle.
    "@anthropic-ai/sdk",
    "@aws-sdk/*",
    "@smithy/*",
    "@google/genai",
    "@mistralai/mistralai",
    "http-proxy-agent",
    "https-proxy-agent",
    "canvas",
    ...builtins,
  ],
  format: "cjs",
  target: "es2020",
  logLevel: "info",
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
