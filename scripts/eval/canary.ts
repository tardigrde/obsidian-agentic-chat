/**
 * The prompt-change canary (#393 T20). Five cases, five runs each. Each case
 * gets a 95% Wilson interval on its pass rate. A case moved only when its
 * baseline pass rate is outside that interval. Inside it, the change is noise
 * at this sample size, whatever the point estimate says.
 *
 * One case outside its interval is not yet a signal: two canary runs on an
 * unchanged `main` (2026-11-18) each put one case outside (tools.easy.search
 * 4/5 and 3/5 against a 3/3 baseline). The verdict is a signal only for a
 * strong move (the rate is at least 60 points from the baseline, for example
 * 1/5 against 100%) or for two cases that move the same way.
 */

export const CANARY_RUNS = 5;
/** A move this far from the baseline rate is a signal on its own. */
export const STRONG_MOVE = 0.6;

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

interface Move {
  id: string;
  signal: "drop" | "gain";
  strong: boolean;
}

/** One table per canary run, and one line that says whether anything moved. */
export function formatCanary(summary: unknown, baseline: unknown): string {
  const base = new Map(rows(baseline).map((row) => [row.id, row.passRate]));
  const lines = ["## Canary", "", "| Case | Pass | 95% Wilson | Baseline | Signal |", "|---|---|---|---|---|"];
  const moves: Move[] = [];
  const unknown: string[] = [];
  for (const row of rows(summary)) {
    const passed = row.passed ?? 0;
    const runs = row.executed ?? 0;
    const interval = wilson(passed, runs);
    const baselineRate = base.get(row.id);
    const signal = canarySignal(passed, runs, baselineRate);
    if (signal === "no baseline") unknown.push(row.id);
    if ((signal === "drop" || signal === "gain") && baselineRate !== undefined) {
      moves.push({ id: row.id, signal, strong: Math.abs(passed / Math.max(runs, 1) - baselineRate) >= STRONG_MOVE });
    }
    lines.push(
      `| ${row.id} | ${passed}/${runs} | [${pct(interval.lower)}, ${pct(interval.upper)}] | ${baselineRate === undefined ? "-" : pct(baselineRate)} | ${signal} |`,
    );
  }
  lines.push("", canaryVerdict(moves, { hasBaseline: base.size > 0, unknown }));
  return `${lines.join("\n")}\n`;
}

export function canaryVerdict(moves: readonly Move[], context: { hasBaseline: boolean; unknown: readonly string[] }): string {
  if (!context.hasBaseline) return "No baseline: nothing to compare against. Write one with --write-baseline first.";
  const named = (list: readonly Move[]) => list.map((move) => `${move.id} (${move.signal})`).join(", ");
  const missing = context.unknown.length > 0 ? ` No baseline for: ${context.unknown.join(", ")}.` : "";
  const drops = moves.filter((move) => move.signal === "drop");
  const gains = moves.filter((move) => move.signal === "gain");
  if (moves.some((move) => move.strong) || drops.length >= 2 || gains.length >= 2) {
    return `Signal: ${named(moves)}. Check base vs head with eval:ab before you act.${missing}`;
  }
  if (moves.length > 0) {
    return `Weak: ${named(moves)}. One case outside its interval is common at 5 runs; run the canary once more. Two runs that agree are a signal.${missing}`;
  }
  return context.unknown.length > 0
    ? `No signal in the cases with a baseline.${missing}`
    : "No signal: every baseline rate is inside its interval.";
}
