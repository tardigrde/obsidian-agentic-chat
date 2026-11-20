const configured = process.env.STRYKER_MUTATE
  ?.split(",")
  .map((file) => file.trim())
  .filter(Boolean);

/**
 * Weekly local mutation run on the five UI hot spots (#393 T18): the most-fixed
 * files. It prints a score per file; it is not a gate (no break threshold).
 * Narrow or widen it with STRYKER_MUTATE (comma-separated paths).
 */
export const HOT_SPOTS = [
  "src/ui/chat-view.ts",
  "src/ui/approval-card.ts",
  "src/main.ts",
  "src/ui/assistant-bubble.ts",
  "src/ui/session-list-modal.ts",
];

export default {
  testRunner: "vitest",
  mutate: configured?.length ? configured : HOT_SPOTS,
  reporters: ["clear-text", "json"],
  jsonReporter: { fileName: "reports/mutation/mutation.json" },
  coverageAnalysis: "perTest",
  timeoutMS: 60_000,
  concurrency: 4,
  // Advisory: the score is printed and never fails the run.
  thresholds: { high: 80, low: 60, break: null },
  tempDirName: ".stryker-tmp",
  cleanTempDir: true,
  ignorePatterns: [
    "coverage/**",
    "logs/**",
    "reports/**",
    "dist/**",
    ".obsidian-cache",
    ".obsidian-cache/**",
    "node_modules/**",
    ".stryker-tmp/**",
    ".claude",
    ".claude/**",
    ".env",
    "docs/**",
    "test/e2e/**",
  ],
};
