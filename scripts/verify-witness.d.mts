export type WitnessRun = { status: number | null; combined: string };
export function verdictFor(
  reverted: WitnessRun,
  restored: WitnessRun,
): { verdict: "PASS" | "FAIL"; reason: string; detail?: string; failedTests?: number };
