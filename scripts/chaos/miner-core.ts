/**
 * Pure logic for mining a finished chaos run.
 *
 * The miner reads what the run left on disk (action log, plugin session JSONL,
 * driver result, timeline), builds one bounded text digest, asks a model to
 * judge it, and turns the judged findings into a report and issue drafts. A
 * person approves each draft before it becomes a GitHub issue.
 */

export type MinerSeverity = "S1" | "S2" | "S3" | "S4";
export type MinerKind = "bug" | "ux" | "perf" | "harness" | "noise";
export type MinerConfidence = "high" | "medium" | "low";

export type MinedFinding = {
  title: string;
  severity: MinerSeverity;
  kind: MinerKind;
  confidence: MinerConfidence;
  steps: string[];
  expected: string;
  actual: string;
  repro: string[];
  evidence: string[];
  duplicateOf?: number;
};

export type MinerReport = {
  summary: string;
  coverage: string[];
  gaps: string[];
  findings: MinedFinding[];
};

export type DigestInput = {
  plan: { mode?: string; charter?: string; model?: string; live?: boolean };
  driver: {
    verdict?: string;
    stopReason?: string;
    tokens?: number;
    findings?: Array<{ severity: string; step: string; message: string }>;
    explorer?: { summary?: string; calls?: number; tokens?: number; cost?: number };
  };
  actions: Array<Record<string, unknown>>;
  timeline: Array<{ t: number; label: string }>;
  sessions: string[];
  openIssues: Array<{ number: number; title: string }>;
  maxChars?: number;
};

const DEFAULT_MAX_CHARS = 160_000;

function clip(value: unknown, max: number): string {
  const text = (typeof value === "string" ? value : value === undefined || value === null ? "" : JSON.stringify(value))
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** `75.4` -> `01:15`. */
export function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
}

/** Map explorer step ids (`x012`) to the video time of their timeline mark. */
export function stepClock(timeline: Array<{ t: number; label: string }>): Map<string, number> {
  const clock = new Map<string, number>();
  for (const entry of timeline) {
    const id = /^(x\d{3})\b/.exec(entry.label)?.[1];
    if (id && !clock.has(id)) clock.set(id, entry.t);
  }
  return clock;
}

/** Condense plugin session JSONL into readable transcript lines. */
export function condenseSessions(texts: string[], maxChars: number): string {
  const lines: string[] = [];
  for (const [index, text] of texts.entries()) {
    lines.push(`--- session ${index + 1}`);
    for (const row of text.split(/\r?\n/)) {
      if (!row.trim()) continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(row) as Record<string, unknown>;
      } catch {
        lines.push("  !! unparseable JSONL line");
        continue;
      }
      const type = String(entry.type ?? "?");
      if (type === "message") {
        const message = (entry.message ?? {}) as {
          role?: string;
          content?: unknown;
          stopReason?: string;
          errorMessage?: string;
          toolName?: string;
          isError?: boolean;
        };
        const parts = Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : [];
        const text = parts
          .map((part) => {
            if (part.type === "text") return clip(part.text, 400);
            if (part.type === "toolCall") return `[tool ${String(part.name)} ${clip(part.arguments, 160)}]`;
            if (part.type === "thinking") return "";
            return `[${String(part.type)}]`;
          })
          .filter(Boolean)
          .join(" ");
        const role = message.role ?? "?";
        const extra = [
          message.toolName ? `tool=${message.toolName}` : "",
          message.isError ? "ERROR" : "",
          message.stopReason && message.stopReason !== "stop" ? `stop=${message.stopReason}` : "",
          message.errorMessage ? `error=${clip(message.errorMessage, 200)}` : "",
        ]
          .filter(Boolean)
          .join(" ");
        lines.push(`  ${role}${extra ? ` (${extra})` : ""}: ${text}`);
      } else if (type !== "session" && type !== "thinking_level_change") {
        lines.push(`  <${type}> ${clip(entry.event ?? entry.customType ?? entry.modelId ?? "", 160)}`);
      }
    }
  }
  const joined = lines.join("\n");
  if (joined.length <= maxChars) return joined;
  // Keep the start and the end: setup and the latest state matter most.
  const half = Math.floor(maxChars / 2);
  return `${joined.slice(0, half)}\n  … (transcript trimmed) …\n${joined.slice(-half)}`;
}

export function buildMinerDigest(input: DigestInput): string {
  const maxChars = input.maxChars ?? DEFAULT_MAX_CHARS;
  const clock = stepClock(input.timeline);
  const head = [
    "RUN",
    `mode=${input.plan.mode ?? "?"} live=${String(input.plan.live)} model=${input.plan.model ?? "?"}`,
    `verdict=${input.driver.verdict ?? "?"} stop=${input.driver.stopReason ?? "?"} tokens=${input.driver.tokens ?? 0}`,
    `charter: ${clip(input.plan.charter ?? "", 800)}`,
    input.driver.explorer?.summary ? `explorer summary: ${clip(input.driver.explorer.summary, 800)}` : "",
    "",
    "DRIVER FINDINGS (automatic oracles, scripted checks, explorer reports)",
    ...(input.driver.findings?.length
      ? input.driver.findings.map((finding) => `- ${finding.severity} ${finding.step}: ${clip(finding.message, 400)}`)
      : ["- none"]),
    "",
    "OPEN CHAOS ISSUES (for duplicate checks)",
    ...(input.openIssues.length ? input.openIssues.map((issue) => `- #${issue.number} ${issue.title}`) : ["- none"]),
    "",
    "STEPS",
  ]
    .filter((line) => line !== undefined)
    .join("\n");

  const steps = input.actions
    .map((action) => {
      const id = String(action.step ?? "?");
      const video = clock.has(id) ? ` [video ${formatClock(clock.get(id) as number)}]` : "";
      const parts = [
        `${id}${video} ${String(action.status ?? "")}: ${clip(action.description ?? action.surface ?? "", 200)} -> ${clip(action.detail, 300)}`,
        action.expect ? `expect: ${clip(action.expect, 200)}` : "",
        action.previous === "surprising" ? `SURPRISING: ${clip(action.surprise, 300)}` : "",
        Array.isArray(action.errors) && action.errors.length > 0 ? `errors: ${clip(action.errors, 400)}` : "",
        Array.isArray(action.signals) && action.signals.length > 0 ? `signals: ${clip(action.signals, 300)}` : "",
      ].filter(Boolean);
      return parts.join(" | ");
    })
    .join("\n");

  // Steps get at most half the digest; the transcript gets what is left.
  const half = Math.floor(maxChars / 2);
  const quarter = Math.floor(maxChars / 4);
  const stepText = steps.length > half ? `${steps.slice(0, quarter)}\n…\n${steps.slice(-quarter)}` : steps;
  const budget = Math.max(10_000, maxChars - head.length - stepText.length);
  return `${head}\n${stepText}\n\nPLUGIN TRANSCRIPT\n${condenseSessions(input.sessions, budget)}`;
}

export function minerSystemPrompt(): string {
  return `You are a senior QA engineer. You read the log of an automated exploratory test run of "Agentic Chat", an Obsidian plugin, and decide which problems are real.

The run had an explorer model that clicked through the real app. Its steps, its expectations, the moments it found surprising, console errors, automatic oracle findings, and the plugin's own session transcript are below.

Separate real product problems from noise:
- "bug": the plugin did something wrong, crashed, lost data, threw an error, or got stuck.
- "ux": it worked but was confusing, gave no feedback, or had a layout problem.
- "perf": it was slow or wasted tokens without need.
- "harness": the test driver or explorer caused the problem (stale ref, wrong action, explorer misunderstanding). Not a product bug.
- "noise": not a problem.
Be strict: a surprise from the explorer is a lead, not proof. The explorer sees only a text list of elements the driver found, not pixels; "X never appeared" with no error and no transcript evidence may be a driver selector gap, so mark it "harness" or give it low confidence unless other evidence confirms it. Use the transcript and errors as evidence. Merge duplicates into one finding. If an open issue already covers it, set duplicate_of to its number.

Reply with ONE JSON object only:
{"summary":"<3-6 sentences: what was covered and the overall health>","coverage":["surfaces exercised"],"gaps":["important surfaces the run did not reach"],"findings":[{"title":"<short, specific>","severity":"S1|S2|S3|S4","kind":"bug|ux|perf|harness|noise","confidence":"high|medium|low","steps":["x012"],"expected":"...","actual":"...","repro":["step 1","step 2"],"evidence":["quote errors or transcript lines"],"duplicate_of":null}]}`;
}

const SEVERITIES = new Set(["S1", "S2", "S3", "S4"]);
const KINDS = new Set(["bug", "ux", "perf", "harness", "noise"]);
const CONFIDENCES = new Set(["high", "medium", "low"]);

function strings(value: unknown, max = 20): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, max) : [];
}

export function parseMinerReport(raw: unknown): MinerReport {
  if (!raw || typeof raw !== "object") throw new Error("miner reply was not an object");
  const record = raw as Record<string, unknown>;
  const findings = (Array.isArray(record.findings) ? record.findings : [])
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .filter((item) => typeof item.title === "string" && item.title.trim() !== "")
    .map((item) => {
      const severity = String(item.severity ?? "S3").toUpperCase();
      const kind = String(item.kind ?? "bug").toLowerCase();
      const confidence = String(item.confidence ?? "medium").toLowerCase();
      const duplicate = Number(item.duplicate_of);
      return {
        title: String(item.title).trim().slice(0, 160),
        severity: (SEVERITIES.has(severity) ? severity : "S3") as MinerSeverity,
        kind: (KINDS.has(kind) ? kind : "bug") as MinerKind,
        confidence: (CONFIDENCES.has(confidence) ? confidence : "medium") as MinerConfidence,
        steps: strings(item.steps),
        expected: typeof item.expected === "string" ? item.expected : "",
        actual: typeof item.actual === "string" ? item.actual : "",
        repro: strings(item.repro),
        evidence: strings(item.evidence),
        duplicateOf: Number.isInteger(duplicate) && duplicate > 0 ? duplicate : undefined,
      };
    });
  const order = { S1: 0, S2: 1, S3: 2, S4: 3 } as const;
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  return {
    summary: typeof record.summary === "string" ? record.summary : "",
    coverage: strings(record.coverage, 40),
    gaps: strings(record.gaps, 40),
    findings,
  };
}

/** Only confident, new product findings become issue drafts. */
export function isDraftWorthy(finding: MinedFinding): boolean {
  return (
    (finding.kind === "bug" || finding.kind === "ux" || finding.kind === "perf") &&
    finding.confidence !== "low" &&
    finding.duplicateOf === undefined
  );
}

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "finding"
  );
}

export type DraftContext = { runDir: string; model: string; clock: Map<string, number> };

export function renderIssueDraft(finding: MinedFinding, context: DraftContext): { title: string; body: string } {
  const clips = finding.steps
    .filter((step) => context.clock.has(step))
    .map((step) => `${step} at ${formatClock(context.clock.get(step) as number)}`);
  const list = (items: string[]): string => (items.length ? items.map((item) => `- ${item}`).join("\n") : "- (none)");
  const numbered = (items: string[]): string =>
    items.length ? items.map((item, index) => `${index + 1}. ${item}`).join("\n") : "1. (see steps in the run log)";
  const body = `Found by an exploratory chaos run (\`${finding.severity}\`, ${finding.kind}, confidence ${finding.confidence}).

## Expected

${finding.expected || "(not stated)"}

## Actual

${finding.actual || "(not stated)"}

## Repro

${numbered(finding.repro)}

## Evidence

${list(finding.evidence)}

## Run

- run folder (local): \`${context.runDir}\`
- steps: ${finding.steps.length ? finding.steps.join(", ") : "-"}
- clip: ${clips.length ? clips.join(", ") : "-"} in \`session.mp4\`
- replay: \`npm run chaos -- --mode explore --replay ${context.runDir}/explorer-decisions.jsonl --live\`
- model: \`${context.model}\`

Promote this to a deterministic test before the fix: a unit, replay, or e2e test that fails today.
`;
  return { title: `chaos: ${finding.title}`, body };
}

export function renderFindingsMarkdown(report: MinerReport, context: DraftContext, drafts: string[]): string {
  const rows = report.findings.length
    ? report.findings
        .map((finding, index) => {
          const clips = finding.steps
            .filter((step) => context.clock.has(step))
            .map((step) => formatClock(context.clock.get(step) as number));
          const dup = finding.duplicateOf ? ` (dup of #${finding.duplicateOf})` : "";
          return `| ${index + 1} | ${finding.severity} | ${finding.kind} | ${finding.confidence} | ${finding.title.replace(/\|/g, "/")}${dup} | ${finding.steps.join(" ") || "-"} | ${clips.join(" ") || "-"} |`;
        })
        .join("\n")
    : "| - | - | - | - | none | - | - |";
  return `# Chaos mining report

${report.summary || "(no summary)"}

## Findings

| # | sev | kind | confidence | title | steps | clip |
|---|---|---|---|---|---|---|
${rows}

## Coverage

${report.coverage.length ? report.coverage.map((item) => `- ${item}`).join("\n") : "- (not stated)"}

## Gaps

${report.gaps.length ? report.gaps.map((item) => `- ${item}`).join("\n") : "- (not stated)"}

## Issue drafts

${drafts.length ? drafts.map((draft) => `- \`issues/${draft}\``).join("\n") : "- none (no confident, new product finding)"}

File approved drafts: \`npm run chaos:file -- ${context.runDir} <draft numbers>\`
`;
}
