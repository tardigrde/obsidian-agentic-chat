import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

// Live tests hit real APIs; opt in via `npm run test:live` (vitest.live.config.ts).
// The e2e suite (test/e2e/**) runs under wdio, not vitest.
const SHARED_EXCLUDE = ["test/live/**", "test/e2e/**", "node_modules/**"];

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "json", "html"],
      reportsDirectory: "./coverage",
    },
    projects: [
      {
        // Logic, against the plain Obsidian mock. No DOM: rendering lives in the `ui` project.
        resolve: { alias: { obsidian: here("./test/mocks/obsidian.ts") } },
        test: {
          name: "unit",
          environment: "node",
          setupFiles: ["./test/setup.ts"],
          include: ["test/**/*.test.ts"],
          exclude: [...SHARED_EXCLUDE, "test/ui/**"],
        },
      },
      {
        // Rendering: a real DOM (happy-dom) with Obsidian's element helpers
        // (createDiv, addClass, setIcon, Modal, ItemView). See test/ui/support/.
        resolve: { alias: { obsidian: here("./test/ui/support/obsidian-dom.ts") } },
        test: {
          name: "ui",
          environment: "happy-dom",
          setupFiles: ["./test/ui/support/setup.ts"],
          include: ["test/ui/**/*.test.ts"],
          exclude: SHARED_EXCLUDE,
        },
      },
    ],
  },
});
