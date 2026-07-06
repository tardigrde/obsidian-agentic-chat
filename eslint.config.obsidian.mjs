/**
 * Scoped ESLint config for the official Obsidian community-plugin checks
 * (https://github.com/obsidianmd/eslint-plugin). Kept separate from the main
 * eslint.config.mjs because the plugin's recommended set enables type-aware
 * typescript-eslint rules that must run with the project tsconfig over `src`,
 * whereas the main config lints a broader file set (docs, configs) without type
 * info. Run via `npm run lint:obsidian`.
 */
import tsparser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  {
    ignores: [
      "node_modules/**",
      "main.js",
      "docs/**",
      "logs/**",
      ".obsidian-cache/**",
      "test/**",
      "scripts/**",
      "esbuild.config.mjs",
    ],
  },
  ...obsidianmd.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsparser,
      globals: {
        Buffer: "readonly",
        process: "readonly",
        require: "readonly",
      },
      parserOptions: { project: "./tsconfig.eslint.json", tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // The plugin targets minAppVersion 1.11.4 (below 1.13.0), where display()
      // is still the required settings-tab API. Migrating to getSettingDefinitions
      // is gated on raising minAppVersion to 1.13.0 — tracked separately.
      "@typescript-eslint/no-deprecated": "off",
      "obsidianmd/settings-tab/no-deprecated-display": "off",
      "obsidianmd/settings-tab/prefer-setting-definitions": "off",
      // Product UI copy intentionally keeps brand/API casing such as OpenRouter,
      // MCP, OAuth, and URL examples; sentence-case cleanup is a separate UX pass.
      "obsidianmd/ui/sentence-case": "off",
    },
  },
]);
