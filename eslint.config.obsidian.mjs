/**
 * Scoped ESLint config for the official Obsidian community-plugin checks
 * (https://github.com/obsidianmd/eslint-plugin). Kept separate from the main
 * eslint.config.mjs because the plugin's recommended set enables type-aware
 * typescript-eslint rules that must run with the project tsconfig over `src`,
 * whereas the main config lints a broader file set (docs, configs) without type
 * info. Run via `npm run lint:obsidian`, which is part of `verify` and CI.
 *
 * This config also mirrors the rules behind the community-plugin review
 * warnings; see docs/development/community-review.md for the two behavior
 * recommendations that are intentional features, not lintable defects.
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
      "src/vendor/**",
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
      // minAppVersion is 1.13.0, so the plugin's recommended no-deprecated
      // options would report SettingTab#display(). The declarative settings
      // migration is tracked separately; keep the method and allow only the
      // display() reference until that migration lands.
      "@typescript-eslint/no-deprecated": [
        "warn",
        {
          allow: [
            // Keep the older-iOS caret fallback allowed (same as the plugin default).
            { from: "lib", name: "caretRangeFromPoint" },
            { from: "package", package: "obsidian", name: "display" },
            { from: "file", name: "display" },
          ],
        },
      ],
      // Setting definitions are now implemented; let the rule warn if they go missing.
      "obsidianmd/settings-tab/prefer-setting-definitions": "warn",
      // display() is intentionally kept until the declarative settings migration
      // lands (separate change). The matching no-deprecated allow above scopes it.
      "obsidianmd/settings-tab/no-deprecated-display": "off",
      // Product UI copy intentionally keeps brand/API casing such as OpenRouter,
      // MCP, OAuth, and URL examples; sentence-case cleanup is a separate UX pass.
      "obsidianmd/ui/sentence-case": "off",
    },
  },
]);
