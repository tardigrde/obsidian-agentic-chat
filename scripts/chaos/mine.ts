#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { CHAOS_MODEL, assertChaosModel, redactSecrets } from "./monkey-core";
import { chatComplete } from "./explorer-llm";
import { extractJsonObject } from "./explorer-core";
import {
  buildMinerDigest,
  isDraftWorthy,
  minerSystemPrompt,
  parseMinerReport,
  renderFindingsMarkdown,
  renderIssueDraft,
  slugify,
  stepClock,
  type MinerReport,
} from "./miner-core";
import { applyEnvFile, hasFlag, readArg } from "../live-support";

/**
 * Mine a finished chaos run: `npm run chaos:mine -- logs/chaos/<run>`.
 *
 * Writes `findings.md`, `miner-report.json`, and `issues/NN-<slug>.md` drafts
 * into the run folder. It never files an issue; `npm run chaos:file` does that
 * after a person picks the drafts.
 */

export type MineOptions = {
  runDir: string;
  apiKey: string;
  baseUrl: string;
  model: string;
};

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function readJsonl(file: string): Promise<Array<Record<string, unknown>>> {
  try {
    return (await readFile(file, "utf8"))
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function openChaosIssues(): Array<{ number: number; title: string }> {
  const result = spawnSync(
    "gh",
    ["issue", "list", "--label", "chaos", "--state", "open", "--limit", "100", "--json", "number,title"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) return [];
  try {
    return JSON.parse(result.stdout) as Array<{ number: number; title: string }>;
  } catch {
    return [];
  }
}

export async function mineRun(options: MineOptions): Promise<{ report: MinerReport; drafts: string[]; cost: number }> {
  const { runDir } = options;
  const plan = await readJson<Record<string, unknown>>(path.join(runDir, "plan.json"), {});
  const driver = await readJson<Record<string, unknown>>(path.join(runDir, "driver-result.json"), {});
  const timeline = await readJson<Array<{ t: number; label: string }>>(path.join(runDir, "timeline.json"), []);
  const actions = await readJsonl(path.join(runDir, "action-log.jsonl"));
  const sessionDir = path.join(runDir, "sessions");
  const sessions = existsSync(sessionDir)
    ? await Promise.all(
        (await readdir(sessionDir))
          .filter((name) => name.endsWith(".jsonl"))
          .sort()
          .map(async (name) => await readFile(path.join(sessionDir, name), "utf8")),
      )
    : [];

  const digest = redactSecrets(
    buildMinerDigest({
      plan: plan as never,
      driver: driver as never,
      actions,
      timeline,
      sessions,
      openIssues: openChaosIssues(),
    }),
    [options.apiKey],
  );
  await writeFile(path.join(runDir, "miner-digest.txt"), digest);

  const reply = await chatComplete({
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    model: options.model,
    json: true,
    maxTokens: 8_000,
    temperature: 0.2,
    timeoutMs: 300_000,
    messages: [
      { role: "system", content: minerSystemPrompt() },
      { role: "user", content: digest },
    ],
  });
  const json = extractJsonObject(reply.text);
  if (!json) throw new Error("miner reply had no JSON object");
  const report = parseMinerReport(JSON.parse(json));
  await writeFile(path.join(runDir, "miner-report.json"), `${JSON.stringify(report, null, 2)}\n`);

  const clock = stepClock(timeline);
  const context = { runDir: path.relative(process.cwd(), runDir) || runDir, model: options.model, clock };
  const issuesDir = path.join(runDir, "issues");
  const drafts: string[] = [];
  const worthy = report.findings.filter(isDraftWorthy);
  if (worthy.length > 0) await mkdir(issuesDir, { recursive: true });
  for (const [index, finding] of worthy.entries()) {
    const draft = renderIssueDraft(finding, context);
    const name = `${String(index + 1).padStart(2, "0")}-${slugify(finding.title)}.md`;
    await writeFile(path.join(issuesDir, name), `# ${draft.title}\n\n${draft.body}`);
    drafts.push(name);
  }
  await writeFile(path.join(runDir, "findings.md"), renderFindingsMarkdown(report, context, drafts));
  return { report, drafts, cost: reply.usage.cost };
}

async function main(): Promise<void> {
  const runDir = path.resolve(process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? "");
  if (!existsSync(path.join(runDir, "action-log.jsonl"))) {
    console.error("[chaos:mine] usage: npm run chaos:mine -- logs/chaos/<run> (needs action-log.jsonl)");
    process.exit(1);
  }
  const envFile = path.resolve(".env");
  if (existsSync(envFile)) applyEnvFile(envFile);
  const apiKey = process.env.AGENTIC_CHAT_API_KEY?.trim();
  if (!apiKey) {
    console.error("[chaos:mine] needs AGENTIC_CHAT_API_KEY");
    process.exit(1);
  }
  const model = assertChaosModel(
    readArg("--model") ?? process.env.AGENTIC_CHAT_CHAOS_MODEL?.trim() ?? CHAOS_MODEL,
    hasFlag("--allow-any-model"),
  );
  const baseUrl = process.env.AGENTIC_CHAT_BASE_URL?.trim() || "https://openrouter.ai/api/v1";
  const { report, drafts, cost } = await mineRun({ runDir, apiKey, baseUrl, model });
  process.stdout.write(`[chaos:mine] findings: ${report.findings.length}, drafts: ${drafts.length}, cost: $${cost.toFixed(4)}\n`);
  process.stdout.write(`[chaos:mine] report: ${path.join(runDir, "findings.md")}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    console.error(`[chaos:mine] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
