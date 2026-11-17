/**
 * The prompt-change canary (#393 T20). Five cases, five runs each. Each case
 * gets a 95% Wilson interval on its pass rate. The signal rule: a case moved
 * only when its baseline pass rate is outside that interval. Inside it, the
 * change is noise at this sample size, whatever the point estimate says.
 */

export const CANARY_RUNS = 5;

/** 95% Wilson score interval for k passes out of n runs. */
export function wilson(passed: number, runs: number, z = 1.96): { lower: number; upper: number } {
  if (runs <= 0) return { lower: 0, upper: 1 };
  const rate = passed / runs;
  const z2 = z * z;
  const denominator = 1 + z2 / runs;
  const centre = (rate + z2 / (2 * runs)) / denominator;
  const margin = (z * Math.sqrt((rate * (1 - rate)) / runs + z2 / (4 * runs * runs))) / denominator;
  return { lower: Math.max(0, centre - margin), upper: Math.min(1, centre + margin) };
}

export type CanarySignal = "drop" | "gain" | "noise" | "no baseline";

export function canarySignal(passed: number, runs: number, baselineRate: number | undefined): CanarySignal {
  if (baselineRate === undefined) return "no baseline";
  const { lower, upper } = wilson(passed, runs);
  if (baselineRate > upper) return "drop";
  if (baselineRate < lower) return "gain";
  return "noise";
}

interface Row {
  id: string;
  passed?: number;
  executed?: number;
  passRate?: number;
}

function rows(input: unknown): Row[] {
  const cases = input && typeof input === "object" ? (input as { cases?: unknown }).cases : undefined;
  return Array.isArray(cases) ? cases.filter((entry): entry is Row => Boolean(entry) && typeof entry.id === "string") : [];
}

const pct = (value: number) => `${Math.round(value * 100)}%`;

/** One table per canary run, and one line that says whether anything moved. */
export function formatCanary(summary: unknown, baseline: unknown): string {
  const base = new Map(rows(baseline).map((row) => [row.id, row.passRate]));
  const lines = ["## Canary", "", "| Case | Pass | 95% Wilson | Baseline | Signal |", "|---|---|---|---|---|"];
  const moved: string[] = [];
  for (const row of rows(summary)) {
    const passed = row.passed ?? 0;
    const runs = row.executed ?? 0;
    const interval = wilson(passed, runs);
    const baselineRate = base.get(row.id);
    const signal = canarySignal(passed, runs, baselineRate);
    if (signal === "drop" || signal === "gain") moved.push(`${row.id} (${signal})`);
    lines.push(
      `| ${row.id} | ${passed}/${runs} | [${pct(interval.lower)}, ${pct(interval.upper)}] | ${baselineRate === undefined ? "-" : pct(baselineRate)} | ${signal} |`,
    );
  }
  lines.push(
    "",
    moved.length > 0
      ? `Signal: ${moved.join(", ")}. Check base vs head with eval:ab before you act.`
      : "No signal: every baseline rate is inside its interval.",
  );
  return `${lines.join("\n")}\n`;
}
