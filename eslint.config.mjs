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
      ".stryker-tmp/**",
      // Copied into a release checkout and run there; it is not linted or type-checked (#290).
      "scripts/release-fixtures/**",
      "reports/**",
      "src/vendor/**",
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
    files: ["src/**/*.ts"],
    ignores: ["src/utils/errors.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "FunctionDeclaration[id.name='errorMessage']",
          message: "Use errorMessage from src/utils/errors.ts.",
        },
      ],
    },
  },
  {
    files: ["src/**/*.ts"],
    ignores: [
      // The envelope lives here; this is the one place the literal shape is allowed.
      "src/tools/result.ts",
      // Owned by another PR; keep the rule quiet until that call site converts.
      "src/mcp/tools.ts",
      // Agent-owned call sites convert in a later batch.
      "src/agent/**",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "Property[key.name='content'] > ArrayExpression > ObjectExpression > Property[key.name='type'][value.value='text']",
          message: "Use toolResult() or untrustedToolResult() from src/tools/result.ts.",
        },
        {
          selector:
            "Property[key.name='content'] > ArrayExpression > ObjectExpression > Property[key.name='type'] > TSAsExpression > Literal[value='text']",
          message: "Use toolResult() or untrustedToolResult() from src/tools/result.ts.",
        },
      ],
    },
  },
  {
    // Layering: `src/settings.ts` is the settings tab (UI). Agent, tool, MCP,
    // and other non-UI modules read settings types and helpers from
    // `settings-schema.ts`, so the tab never enters their import graph.
    files: ["src/*/**/*.ts"],
    ignores: ["src/ui/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "^(\\.\\./)+settings$",
              message: "Import settings types and helpers from settings-schema; settings.ts is the UI tab.",
            },
          ],
        },
      ],
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
