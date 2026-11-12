#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { CHAOS_MODEL, assertChaosModel, redactSecrets } from "./monkey-core";
import { chatComplete, type ChatMessage, type ChatReply } from "./explorer-llm";
import {
  buildMinerDigest,
  isDraftWorthy,
  minerSystemPrompt,
  MINER_JSON_ONLY_RETRY,
  MINER_MAX_TOKENS,
  minerRawLog,
  parseMinerReply,
  renderFindingsMarkdown,
  renderIssueDraft,
  slugify,
  stepClock,
  type MinerReport,
} from "./miner-core";
import { applyEnvFile, hasFlag, readArg } from "../live-support";
import { llmHeaders, parseLlmName, resolveChaosLlm, type ChaosLlmName } from "./llm-provider";

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
  llm?: ChaosLlmName;
  backend?: "http" | "opencode";
  /** More secrets to strip from the digest, for example the plugin's key. */
  redact?: Array<string | undefined>;
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
    "gh", // NOSONAR:S4036 — gh is a fixed developer binary resolved from the user's PATH; this script is not a privileged service.
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
    [options.apiKey, ...(options.redact ?? [])],
  );
  await writeFile(path.join(runDir, "miner-digest.txt"), digest);

  const messages: ChatMessage[] = [
    { role: "system", content: minerSystemPrompt() },
    { role: "user", content: digest },
  ];
  const ask = async (maxTokens: number): Promise<ChatReply> =>
    await chatComplete({
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      model: options.model,
      json: true,
      backend: options.backend ?? "http",
      headers: llmHeaders(options.llm, `chaos-mine-${path.basename(runDir)}`),
      maxTokens,
      temperature: 0.2,
      timeoutMs: 300_000,
      messages,
    });
  let reply = await ask(MINER_MAX_TOKENS);
  let parsed = parseMinerReply(reply.text);
  if (!parsed.ok) {
    // Keep the bad reply for debugging, then ask once more for JSON only. A
    // reply cut off at the token cap gets twice the room.
    await writeFile(path.join(runDir, "miner-raw-1.txt"), minerRawLog(reply, parsed.error));
    messages.push(
      { role: "assistant", content: reply.text.slice(0, 4_000) },
      { role: "user", content: MINER_JSON_ONLY_RETRY },
    );
    reply = await ask(reply.finishReason === "length" ? MINER_MAX_TOKENS * 2 : MINER_MAX_TOKENS);
    parsed = parseMinerReply(reply.text);
    if (!parsed.ok) {
      await writeFile(path.join(runDir, "miner-raw-2.txt"), minerRawLog(reply, parsed.error));
      throw new Error(`miner reply was not a usable report after a retry: ${parsed.error}; see miner-raw-*.txt`);
    }
  }
  const report = parsed.report;
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
  const llm = resolveChaosLlm(parseLlmName(readArg("--llm") ?? process.env.AGENTIC_CHAT_CHAOS_LLM));
  if (llm.backend === "http" && !llm.apiKey) {
    console.error(`[chaos:mine] needs a key for ${llm.name} (${llm.keySource})`);
    process.exit(1);
  }
  const model = assertChaosModel(readArg("--model") ?? (llm.model || CHAOS_MODEL), hasFlag("--allow-any-model"));
  const { report, drafts, cost } = await mineRun({
    runDir,
    apiKey: llm.apiKey ?? "",
    baseUrl: llm.baseUrl,
    model,
    llm: llm.name,
    backend: llm.backend,
    // The plugin under test may have used a different key than the miner.
    redact: [process.env.AGENTIC_CHAT_API_KEY?.trim()],
  });
  const costLabel = llm.backend === "opencode" ? "subscription" : `$${cost.toFixed(4)}`;
  process.stdout.write(`[chaos:mine] findings: ${report.findings.length}, drafts: ${drafts.length}, cost: ${costLabel}\n`);
  process.stdout.write(`[chaos:mine] report: ${path.join(runDir, "findings.md")}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    console.error(`[chaos:mine] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
