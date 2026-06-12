import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Config for live OpenRouter integration tests. Run via `npm run test:live`.
export default defineConfig({
  resolve: {
    alias: {
      obsidian: fileURLToPath(new URL("./test/mocks/obsidian.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["test/live/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
