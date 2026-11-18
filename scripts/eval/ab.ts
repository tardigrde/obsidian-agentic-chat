/**
 * `npm run eval:ab`: the same cases on a base commit and on the current tree,
 * one after the other, in one table (#392 item 1). The pure parts live here:
 * argument parsing, the plan, and the table. `scripts/eval-ab.ts` runs it.
 */

import * as path from "node:path";
import { parseArgs } from "node:util";
import { bootstrapCompare, formatSignificance, type SignificanceCase } from "./significance";

export const AB_DEFAULT_SUITE = "test/evals/tool-use/core.eval.json";
export const AB_DEFAULT_RUNS = 5;

export interface AbArgs {
  cases: string[];
  runs: number;
  base: string;
  suite: string;
  maxUsd?: number;
  envFile?: string;
  dryRun: boolean;
  /** Run each side under `npm run nested` (a desktop DISPLAY); off with --no-nested. */
  nested: boolean;
  help: boolean;
}

export const AB_USAGE = `Usage:
  npm run eval:ab -- --case <id[,id]> [--runs 5] [--base origin/main] [--suite path]
      [--max-usd usd] [--env-file path] [--dry-run] [--no-nested]

Runs the cases on --base (a temporary detached worktree) and then on the current
tree, and prints one table. Both summaries land under logs/eval-runs/ab-<stamp>/.
--max-usd caps each side. --dry-run prints the plan and makes no model call.
`;

export function parseAbArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): AbArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      case: { type: "string", multiple: true },
      runs: { type: "string" },
      base: { type: "string" },
      suite: { type: "string" },
      "max-usd": { type: "string" },
      "env-file": { type: "string" },
      "dry-run": { type: "boolean" },
      "no-nested": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const cases = (values.case ?? []).flatMap((value) => value.split(",")).map((id) => id.trim()).filter(Boolean);
  const help = values.help === true;
  if (!help && cases.length === 0) throw new Error("--case <id[,id]> is required");
  const runs = values.runs === undefined ? AB_DEFAULT_RUNS : Number(values.runs);
  if (!Number.isInteger(runs) || runs <= 0) throw new Error(`--runs must be a positive integer, got ${values.runs}`);
  const maxUsd = values["max-usd"] === undefined ? undefined : Number(values["max-usd"]);
  if (maxUsd !== undefined && (Number.isNaN(maxUsd) || maxUsd <= 0)) throw new Error(`--max-usd must be a positive number, got ${values["max-usd"]}`);
  return {
    cases: [...new Set(cases)],
    runs,
    base: values.base ?? "origin/main",
    suite: values.suite ?? AB_DEFAULT_SUITE,
    maxUsd,
    envFile: values["env-file"],
    dryRun: values["dry-run"] === true,
    nested: values["no-nested"] !== true && Boolean(env.DISPLAY),
    help,
  };
}

export interface AbSide {
  label: "base" | "head";
  /** The tree the runner runs in. */
  cwd: string;
  outDir: string;
  command: string[];
}

export interface AbPlan {
  stamp: string;
  root: string;
  baseRef: string;
  baseWorktree: string;
  sides: [AbSide, AbSide];
}

/** Both sides with the exact command each one runs. `headRoot` is the current tree. */
export function abPlan(args: AbArgs, options: { headRoot: string; stamp: string; tmpDir: string }): AbPlan {
  const root = path.join(options.headRoot, "logs", "eval-runs", `ab-${options.stamp}`);
  const baseWorktree = path.join(options.tmpDir, `agentic-chat-ab-${options.stamp}`);
  const side = (label: "base" | "head", cwd: string): AbSide => {
    const outDir = path.join(root, label);
    const runner = [
      "node",
      "--import",
      "tsx",
      "scripts/run-tool-use-evals.ts",
      "--suite",
      args.suite,
      "--case",
      args.cases.join(","),
      "--runs",
      String(args.runs),
      "--run-id",
      `ab-${options.stamp}-${label}`,
      "--out-dir",
      outDir,
      ...(args.maxUsd === undefined ? [] : ["--max-usd", String(args.maxUsd)]),
      ...(args.envFile ? ["--env-file", path.resolve(options.headRoot, args.envFile)] : []),
    ];
    // The nested helper comes from the current tree, so the base needs none.
    const command = args.nested ? ["node", path.join(options.headRoot, "scripts/run-nested.mjs"), ...runner] : runner;
    return { label, cwd, outDir, command };
  };
  return {
    stamp: options.stamp,
    root,
    baseRef: args.base,
    baseWorktree,
    sides: [side("base", baseWorktree), side("head", options.headRoot)],
  };
}

export function formatAbPlan(plan: AbPlan): string {
  const lines = [
    `eval:ab ${plan.stamp}`,
    `base: ${plan.baseRef} in ${plan.baseWorktree} (temporary detached worktree)`,
    `head: current tree ${plan.sides[1].cwd}`,
    `output: ${plan.root}`,
    "",
  ];
  for (const side of plan.sides) lines.push(`${side.label}: (cd ${side.cwd} && ${side.command.join(" ")})`);
  return `${lines.join("\n")}\n`;
}

interface AbCaseRow {
  id: string;
  passed?: number;
  executed?: number;
  meanToolCalls?: number;
  meanUsd?: number;
  medianMs?: number;
  passAllK?: number;
  passRate?: number;
}

function rows(summary: unknown): Map<string, AbCaseRow> {
  const output = new Map<string, AbCaseRow>();
  const cases = summary && typeof summary === "object" ? (summary as { cases?: unknown }).cases : undefined;
  if (!Array.isArray(cases)) return output;
  for (const entry of cases) {
    if (entry && typeof entry === "object" && typeof (entry as AbCaseRow).id === "string") output.set((entry as AbCaseRow).id, entry as AbCaseRow);
  }
  return output;
}

const pass = (row?: AbCaseRow) => (row?.executed === undefined ? "-" : `${row.passed ?? 0}/${row.executed}`);
const num = (value: number | undefined, format: (value: number) => string) => (value === undefined ? "-" : format(value));
const pair = (left: string, right: string) => `${left} -> ${right}`;
const calls = (value: number) => value.toFixed(1);
const dollars = (value: number) => "$" + value.toFixed(5);
const secs = (value: number) => (value / 1000).toFixed(1);

/** One table: case, base pass k/n, head pass k/n, mean tool calls, mean USD, median time; a bootstrap under it for 2+ cases. */
export function formatAbTable(base: unknown, head: unknown): string {
  const before = rows(base);
  const after = rows(head);
  const ids = [...new Set([...before.keys(), ...after.keys()])];
  const lines = [
    "| Case | Base pass | Head pass | Mean tool calls | Mean USD | Median s |",
    "|---|---|---|---|---|---|",
  ];
  for (const id of ids) {
    const left = before.get(id);
    const right = after.get(id);
    lines.push(
      [
        "",
        id,
        pass(left),
        pass(right),
        pair(num(left?.meanToolCalls, calls), num(right?.meanToolCalls, calls)),
        pair(num(left?.meanUsd, dollars), num(right?.meanUsd, dollars)),
        pair(num(left?.medianMs, secs), num(right?.medianMs, secs)),
        "",
      ].join(" | ").trim(),
    );
  }
  let text = `${lines.join("\n")}\n`;
  const shared = ids.filter((id) => before.has(id) && after.has(id));
  if (shared.length >= 2) {
    const toCase = (row: AbCaseRow): SignificanceCase => ({
      id: row.id,
      passAllK: typeof row.passAllK === "number" ? row.passAllK : Number.NaN,
      passRate: row.passRate,
      meanUsd: row.meanUsd,
      medianMs: row.medianMs,
    });
    const costComparable = costSource(base) === "billed" && costSource(head) === "billed";
    const result = bootstrapCompare(
      shared.map((id) => toCase(before.get(id) as AbCaseRow)),
      shared.map((id) => toCase(after.get(id) as AbCaseRow)),
      { costComparable },
    );
    text += `\n${formatSignificance(result, { before: "Base", after: "Head" })}`;
  }
  return text;
}

function costSource(summary: unknown): string | undefined {
  const value = summary && typeof summary === "object" ? (summary as { costSource?: unknown }).costSource : undefined;
  return typeof value === "string" ? value : undefined;
}

/**
 * The names in `config/worktree-links`, with the same rules as
 * `scripts/worktree.mjs`: no absolute path, `.`, `..` segment, or `.git` entry.
 */
export function linkNames(text: string): string[] {
  const names: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = line.replaceAll("\\", "/");
    if (path.isAbsolute(line) || normalized === "." || normalized.split("/").includes("..")) continue;
    if (normalized === ".git" || normalized.startsWith(".git/")) continue;
    names.push(normalized);
  }
  return names;
}
