const configured = process.env.STRYKER_MUTATE
  ?.split(",")
  .map((file) => file.trim())
  .filter(Boolean);

/** STRYKER_REPORT_ONLY=1: never fail on the score (nightly changed-files run). */
const reportOnly = process.env.STRYKER_REPORT_ONLY === "1";

/**
 * Mutation gate for the state-machine core. Run it on demand with
 * `npm run mutation`; a local run can narrow it with STRYKER_MUTATE.
 */
export default {
  testRunner: "vitest",
  mutate: configured?.length
    ? configured
    : ["src/agent/loop-guard.ts", "src/agent/session-swap-queue.ts"],
  reporters: ["clear-text", "json"],
  jsonReporter: { fileName: reportOnly ? "reports/mutation/changed.json" : "reports/mutation/mutation.json" },
  coverageAnalysis: "perTest",
  timeoutMS: 60_000,
  concurrency: 2,
  thresholds: { high: 85, low: 75, break: reportOnly ? null : 70 },
  tempDirName: ".stryker-tmp",
  cleanTempDir: true,
  ignorePatterns: [
    "coverage/**",
    "logs/**",
    "reports/**",
    "dist/**",
    ".obsidian-cache/**",
    "node_modules/**",
    ".stryker-tmp/**",
  ],
};
