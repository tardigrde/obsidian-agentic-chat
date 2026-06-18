import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      obsidian: fileURLToPath(new URL("./test/mocks/obsidian.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.ts"],
    // Live tests hit the real OpenRouter API; opt in via `npm run test:live`.
    // The e2e suite (test/e2e/**) runs under wdio, not vitest.
    exclude: ["test/live/**", "test/e2e/**", "node_modules/**"],
  },
});
