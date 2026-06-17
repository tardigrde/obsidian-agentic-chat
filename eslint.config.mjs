// Lean flat config: typescript-eslint (non-type-checked, so it stays fast and
// needs no parser project wiring) + a few project-specific rules. This is the
// base lint gate; richer formatting/import rules are tracked as `D2` in ROADMAP.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    // Build output, deps, and the separate e2e toolchain (its own ESM/wdio types) are never linted.
    ignores: [
      "main.js",
      "node_modules/**",
      "esbuild.config.mjs",
      "test/e2e/**",
      "wdio.conf.mjs",
      "wdio.conf.mts",
      ".obsidian-cache/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "test/**/*.ts", "*.ts", "*.mjs", "scripts/**/*.mjs"],
    languageOptions: {
      // The plugin runs in the Obsidian renderer (DOM) on top of Node APIs.
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      // Allow intentionally-unused args/vars when prefixed with `_` (e.g. destructured drops).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      // Floating promises are a real bug class in an event-driven agent loop, but
      // full type-aware linting is the heavier `D2` follow-up — keep the base lean.
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
);
