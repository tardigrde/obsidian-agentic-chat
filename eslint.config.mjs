import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";
import noUnsanitized from "eslint-plugin-no-unsanitized";
import { fileURLToPath } from "node:url";

const tsconfigRootDir = fileURLToPath(new URL(".", import.meta.url));

export default tseslint.config(
  {
    // Build output and deps are never linted.
    ignores: [
      "main.js",
      "node_modules/**",
      "esbuild.config.mjs",
      "docs/.vitepress/cache/**",
      "docs/.vitepress/dist/**",
      "logs/**",
      ".obsidian-cache/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "test/**/*.ts", "*.ts", "*.mjs", "*.mts", "scripts/**/*.mjs"],
    plugins: {
      "no-unsanitized": noUnsanitized,
    },
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
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-unsanitized/method": "error",
      "no-unsanitized/property": "error",
    },
  },
  {
    files: [
      "src/**/*.ts",
      "test/**/*.ts",
      "scripts/**/*.ts",
      "vitest.config.ts",
      "vitest.live.config.ts",
      "wdio.conf.mts",
    ],
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.eslint.json", "./tsconfig.e2e.json"],
        tsconfigRootDir,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
    },
  },
);
