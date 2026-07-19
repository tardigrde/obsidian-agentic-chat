import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const USAGE_KEYS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"];
const REPORT_LIMIT = 12;

if (isCliEntrypoint()) {
  main();
}

export function analyzePath(input) {
  const files = resolveSessionFiles(input);
  if (files.length === 0) {
    throw new Error(`No JSONL session files found at ${input}`);
  }
  const summaries = files.map((file) => analyzeSessionFile(file));
  const aggregate = combineSummaries(summaries);
  return { files: summaries, aggregate };
}

export function compareAnalyses(before, after) {
  const beforeMetrics = metricSnapshot(before);
  const afterMetrics = metricSnapshot(after);
  const metricKeys = [...new Set([...Object.keys(beforeMetrics), ...Object.keys(afterMetrics)])];
  return {
    metrics: metricKeys.map((key) => ({
      key,
      before: beforeMetrics[key] ?? 0,
      after: afterMetrics[key] ?? 0,
      delta: (afterMetrics[key] ?? 0) - (beforeMetrics[key] ?? 0),
    })),
    toolStartsByTool: compareRecords(before.aggregate?.toolStartsByTool, after.aggregate?.toolStartsByTool),
    toolErrorsByTool: compareRecords(before.aggregate?.toolErrorsByTool, after.aggregate?.toolErrorsByTool),
    repeatedExternalPathActions: compareRepeatedItems(
      before.aggregate?.repeatedExternalPathActions,
      after.aggregate?.repeatedExternalPathActions,
    ),
    repeatedActiveNoteBodies: compareRepeatedItems(
      before.aggregate?.repeatedActiveNoteBodies,
      after.aggregate?.repeatedActiveNoteBodies,
    ),
    duplicateToolStarts: compareRepeatedItems(before.aggregate?.duplicateToolStarts, after.aggregate?.duplicateToolStarts),
  };
}

export function formatAnalysisMarkdown(analysis) {
  const aggregate = analysis.aggregate ?? {};
  const lines = ["# Session Trace Summary", ""];
  lines.push(
    markdownTable(
      ["Metric", "Value"],
      [
        ["Sessions", aggregate.sessions ?? 0],
        ["Turns", aggregate.turns ?? 0],
        ["Messages", `user ${aggregate.messages?.user ?? 0}, assistant ${aggregate.messages?.assistant ?? 0}`],
        ["Tool starts", aggregate.toolStarts ?? 0],
        ["Cache hits", aggregate.cacheHits ?? 0],
        ["Max user message chars", aggregate.maxUserMessageChars ?? 0],
        ["Max assistant input tokens", aggregate.maxAssistantInput ?? 0],
        ["Total tokens", aggregate.usage?.totalTokens ?? 0],
        ["Cache-read tokens", aggregate.usage?.cacheRead ?? 0],
      ],
    ),
  );

  appendCountTable(lines, "Tool Starts", aggregate.toolStartsByTool);
  appendRepeatedTable(lines, "Repeated Active Note Bodies", aggregate.repeatedActiveNoteBodies);
  appendRepeatedTable(lines, "Repeated External Path Actions", aggregate.repeatedExternalPathActions);
  appendRepeatedTable(lines, "Duplicate Exact Tool Starts", aggregate.duplicateToolStarts);
  appendCountTable(lines, "Tool Errors", aggregate.toolErrorsByTool);
  appendRepeatedTable(lines, "Approval Denials", aggregate.approvalDenialReasons);
  appendTurnSignals(lines, analysis.files ?? []);
  return `${lines.join("\n")}\n`;
}

export function formatComparisonMarkdown(comparison) {
  const lines = ["# Session Trace Comparison", ""];
  lines.push(
    markdownTable(
      ["Metric", "Before", "After", "Delta"],
      comparison.metrics.map((metric) => [metric.key, metric.before, metric.after, signed(metric.delta)]),
    ),
  );
  appendDeltaTable(lines, "Tool Start Changes", comparison.toolStartsByTool);
  appendDeltaTable(lines, "Tool Error Changes", comparison.toolErrorsByTool);
  appendDeltaTable(lines, "Repeated Active Note Body Changes", comparison.repeatedActiveNoteBodies);
  appendDeltaTable(lines, "Repeated External Path Action Changes", comparison.repeatedExternalPathActions);
  appendDeltaTable(lines, "Duplicate Tool Start Changes", comparison.duplicateToolStarts);
  return `${lines.join("\n")}\n`;
}

function main() {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) {
    console.error(usageText());
    process.exit(1);
  }
  try {
    if (args.compare) {
      const comparison = compareAnalyses(analyzePath(args.compare[0]), analyzePath(args.compare[1]));
      process.stdout.write(args.format === "markdown" ? formatComparisonMarkdown(comparison) : `${JSON.stringify(comparison, null, 2)}\n`);
      return;
    }
    const analysis = analyzePath(args.input);
    process.stdout.write(args.format === "markdown" ? formatAnalysisMarkdown(analysis) : `${JSON.stringify(analysis, null, 2)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

function parseCliArgs(argv) {
  const parsed = { format: "json", input: undefined, compare: undefined, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      parsed.help = true;
      continue;
    }
    if (arg === "--format") {
      parsed.format = readFormat(argv[++index]);
      continue;
    }
    if (arg?.startsWith("--format=")) {
      parsed.format = readFormat(arg.slice("--format=".length));
      continue;
    }
    if (arg === "--compare") {
      const before = argv[++index];
      const after = argv[++index];
      if (!before || !after) throw new Error("--compare requires <before-session-path> <after-session-path>.");
      parsed.compare = [before, after];
      continue;
    }
    if (arg?.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    if (parsed.input) throw new Error(`Unexpected extra input: ${arg}`);
    parsed.input = arg;
  }
  if (!parsed.input && !parsed.compare) parsed.help = true;
  return parsed;
}

function readFormat(value) {
  if (value === "json" || value === "markdown") return value;
  throw new Error(`Unsupported --format value: ${String(value)}`);
}

function usageText() {
  return [
    "Usage:",
    "  node scripts/analyze-session-trace.mjs <session.jsonl|sessions-dir> [--format json|markdown]",
    "  node scripts/analyze-session-trace.mjs --compare <before-session-path> <after-session-path> [--format json|markdown]",
  ].join("\n");
}

function isCliEntrypoint() {
  const entrypoint = process.argv[1];
  return typeof entrypoint === "string" && import.meta.url === pathToFileURL(entrypoint).href;
}

function resolveSessionFiles(target) {
  const resolved = path.resolve(target);
  if (!fs.existsSync(resolved)) return [];
  const stat = fs.statSync(resolved);
  if (stat.isFile()) return [resolved];
  if (!stat.isDirectory()) return [];
  return fs
    .readdirSync(resolved)
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .map((name) => path.join(resolved, name));
}

function analyzeSessionFile(file) {
  const lines = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  const usage = emptyUsage();
  const messages = { user: 0, assistant: 0 };
  const toolStartsByTool = {};
  const exactToolCalls = {};
  const externalPathActions = {};
  const seenToolCallIds = new Set();
  const activeNoteBodyCounts = {};
  const activeNoteCounts = {};
  const approvalDecisionsByTool = {};
  const approvalDenialReasons = {};
  const toolErrorsByTool = {};
  const noteMutations = {};
  let toolStarts = 0;
  let cacheHits = 0;
  let maxUserMessageChars = 0;
  let maxAssistantInput = 0;
  const turnStates = [];
  let currentTurn = null;

  for (const entry of lines) {
    if (entry.type === "message") {
      const message = entry.message ?? {};
      if (message.role === "user") {
        const text = contentText(message);
        currentTurn = createTurnState(turnStates.length, text);
        turnStates.push(currentTurn);
        messages.user += 1;
        maxUserMessageChars = Math.max(maxUserMessageChars, text.length);
        const active = activeNotePath(text) ?? "(none)";
        activeNoteCounts[active] = (activeNoteCounts[active] ?? 0) + 1;
        const body = activeNoteBody(text);
        if (body) countActiveNoteBody(activeNoteBodyCounts, body);
      }
      if (message.role === "assistant") {
        const turn = ensureTurn(turnStates, currentTurn);
        currentTurn = turn;
        messages.assistant += 1;
        const current = message.usage ?? {};
        addUsage(usage, current);
        addUsage(turn.summary.usage, current);
        maxAssistantInput = Math.max(maxAssistantInput, numeric(current.input));
        turn.summary.maxAssistantInput = Math.max(turn.summary.maxAssistantInput, numeric(current.input));
        for (const part of Array.isArray(message.content) ? message.content : []) {
          if (part?.type === "toolCall") {
            recordToolStart(part.name ?? "(unknown)", part.id, part.arguments ?? {});
          }
        }
      }
      if (message.role === "toolResult" && message.details?.cached === true) {
        const turn = ensureTurn(turnStates, currentTurn);
        currentTurn = turn;
        cacheHits += 1;
        turn.summary.cacheHits += 1;
      }
    }

    const event = entry.event;
    if (entry.type === "action_audit" && event?.category === "tool_call" && event.action === "start") {
      recordToolStart(event.toolName, event.toolCallId, event.args ?? {});
    }

    if (entry.type === "action_audit" && event?.category === "tool_call" && event.action === "end" && event.isError) {
      const turn = ensureTurn(turnStates, currentTurn);
      currentTurn = turn;
      toolErrorsByTool[event.toolName] = (toolErrorsByTool[event.toolName] ?? 0) + 1;
      turn.summary.toolErrorsByTool[event.toolName] = (turn.summary.toolErrorsByTool[event.toolName] ?? 0) + 1;
    }

    if (entry.type === "action_audit" && event?.category === "approval" && event.action === "decision") {
      const turn = ensureTurn(turnStates, currentTurn);
      currentTurn = turn;
      const decisionKey = `${event.toolName}:${event.decision}`;
      approvalDecisionsByTool[decisionKey] = (approvalDecisionsByTool[decisionKey] ?? 0) + 1;
      turn.summary.approvalDecisionsByTool[decisionKey] = (turn.summary.approvalDecisionsByTool[decisionKey] ?? 0) + 1;
      if (event.decision === "denied") {
        const reason = event.reason ?? "(none)";
        const reasonKey = `${event.toolName}: ${reason}`;
        approvalDenialReasons[reasonKey] = (approvalDenialReasons[reasonKey] ?? 0) + 1;
        turn.approvalDenialReasons[reasonKey] = (turn.approvalDenialReasons[reasonKey] ?? 0) + 1;
      }
      const mutation = mutationKey(event);
      if (mutation && mutationDecisionApplies(event.decision)) noteMutations[mutation] = (noteMutations[mutation] ?? 0) + 1;
    }
  }

  const turns = turnStates.map(finalizeTurnState);

  return {
    file,
    lineCount: lines.length,
    messages,
    usage,
    turns,
    cacheHits,
    maxUserMessageChars,
    maxAssistantInput,
    toolStarts,
    toolStartsByTool,
    duplicateToolStarts: repeated(exactToolCalls),
    repeatedExternalPathActions: repeated(externalPathActions),
    approvalDecisionsByTool,
    approvalDenialReasons: repeatedIncludingSingles(approvalDenialReasons),
    toolErrorsByTool,
    noteMutations: repeatedIncludingSingles(noteMutations),
    activeNoteCounts,
    activeNoteBodyCounts,
    repeatedActiveNoteBodies: repeatedActiveNoteBodies(activeNoteBodyCounts),
  };

  function recordToolStart(toolName, toolCallId, args) {
    if (toolCallId && seenToolCallIds.has(toolCallId)) return;
    if (toolCallId) seenToolCallIds.add(toolCallId);
    const turn = ensureTurn(turnStates, currentTurn);
    currentTurn = turn;
    toolStarts += 1;
    toolStartsByTool[toolName] = (toolStartsByTool[toolName] ?? 0) + 1;
    const exactKey = exactToolCallKeyFrom(toolName, args);
    exactToolCalls[exactKey] = (exactToolCalls[exactKey] ?? 0) + 1;
    turn.summary.toolStarts += 1;
    turn.summary.toolStartsByTool[toolName] = (turn.summary.toolStartsByTool[toolName] ?? 0) + 1;
    turn.summary.toolCalls.push({
      toolName,
      toolCallId,
      argsSummary: summarizeArgs(args),
    });
    turn.exactToolCalls[exactKey] = (turn.exactToolCalls[exactKey] ?? 0) + 1;
    if (toolName === "external_inspect") {
      const pathActionKey = externalPathActionKeyFrom(args);
      externalPathActions[pathActionKey] = (externalPathActions[pathActionKey] ?? 0) + 1;
      turn.externalPathActions[pathActionKey] = (turn.externalPathActions[pathActionKey] ?? 0) + 1;
    }
  }
}

function combineSummaries(summaries) {
  const aggregate = {
    sessions: summaries.length,
    lineCount: 0,
    messages: { user: 0, assistant: 0 },
    usage: emptyUsage(),
    turns: 0,
    cacheHits: 0,
    maxUserMessageChars: 0,
    maxAssistantInput: 0,
    toolStarts: 0,
    toolStartsByTool: {},
    approvalDecisionsByTool: {},
    approvalDenialReasons: [],
    toolErrorsByTool: {},
    noteMutations: [],
    activeNoteCounts: {},
    repeatedActiveNoteBodies: [],
    duplicateToolStarts: [],
    repeatedExternalPathActions: [],
    findings: [],
  };
  const duplicateToolStarts = {};
  const repeatedExternalPathActions = {};
  const activeNoteBodyCounts = {};
  const approvalDenialReasons = {};
  const noteMutations = {};
  for (const summary of summaries) {
    aggregate.lineCount += summary.lineCount;
    aggregate.messages.user += summary.messages.user;
    aggregate.messages.assistant += summary.messages.assistant;
    addUsage(aggregate.usage, summary.usage);
    aggregate.turns += summary.turns.length;
    aggregate.cacheHits += summary.cacheHits;
    aggregate.maxUserMessageChars = Math.max(aggregate.maxUserMessageChars, summary.maxUserMessageChars);
    aggregate.maxAssistantInput = Math.max(aggregate.maxAssistantInput, summary.maxAssistantInput);
    aggregate.toolStarts += summary.toolStarts;
    for (const [tool, count] of Object.entries(summary.toolStartsByTool)) {
      aggregate.toolStartsByTool[tool] = (aggregate.toolStartsByTool[tool] ?? 0) + count;
    }
    for (const [key, count] of Object.entries(summary.approvalDecisionsByTool)) {
      aggregate.approvalDecisionsByTool[key] = (aggregate.approvalDecisionsByTool[key] ?? 0) + count;
    }
    for (const [tool, count] of Object.entries(summary.toolErrorsByTool)) {
      aggregate.toolErrorsByTool[tool] = (aggregate.toolErrorsByTool[tool] ?? 0) + count;
    }
    for (const [activeNote, count] of Object.entries(summary.activeNoteCounts)) {
      aggregate.activeNoteCounts[activeNote] = (aggregate.activeNoteCounts[activeNote] ?? 0) + count;
    }
    mergeActiveNoteBodyCounts(activeNoteBodyCounts, summary.activeNoteBodyCounts);
    mergeRepeatedCounts(duplicateToolStarts, summary.duplicateToolStarts);
    mergeRepeatedCounts(repeatedExternalPathActions, summary.repeatedExternalPathActions);
    mergeRepeatedCounts(approvalDenialReasons, summary.approvalDenialReasons);
    mergeRepeatedCounts(noteMutations, summary.noteMutations);
  }
  aggregate.duplicateToolStarts = repeatedIncludingSingles(duplicateToolStarts);
  aggregate.repeatedExternalPathActions = repeatedIncludingSingles(repeatedExternalPathActions);
  aggregate.repeatedActiveNoteBodies = repeatedActiveNoteBodies(activeNoteBodyCounts);
  aggregate.approvalDenialReasons = repeatedIncludingSingles(approvalDenialReasons);
  aggregate.noteMutations = repeatedIncludingSingles(noteMutations);
  aggregate.findings = buildFindings(aggregate);
  return aggregate;
}

function createTurnState(index, text) {
  const active = activeNotePath(text) ?? "(none)";
  return {
    summary: {
      index,
      synthetic: false,
      userChars: text.length,
      userExcerpt: excerpt(text),
      activeNote: active,
      usage: emptyUsage(),
      maxAssistantInput: 0,
      toolStarts: 0,
      toolStartsByTool: {},
      toolCalls: [],
      duplicateToolStarts: [],
      repeatedExternalPathActions: [],
      approvalDecisionsByTool: {},
      approvalDenialReasons: [],
      toolErrorsByTool: {},
      cacheHits: 0,
    },
    exactToolCalls: {},
    externalPathActions: {},
    approvalDenialReasons: {},
  };
}

function ensureTurn(turnStates, currentTurn) {
  if (currentTurn) return currentTurn;
  const turn = createTurnState(turnStates.length, "(events before first user message)");
  turn.summary.synthetic = true;
  turn.summary.userChars = 0;
  turn.summary.userExcerpt = "(events before first user message)";
  turnStates.push(turn);
  return turn;
}

function finalizeTurnState(turn) {
  return {
    ...turn.summary,
    duplicateToolStarts: repeated(turn.exactToolCalls),
    repeatedExternalPathActions: repeated(turn.externalPathActions),
    approvalDenialReasons: repeatedIncludingSingles(turn.approvalDenialReasons),
  };
}

function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
}

function addUsage(target, source) {
  for (const key of USAGE_KEYS) target[key] += numeric(source?.[key]);
}

function exactToolCallKeyFrom(toolName, args) {
  return `${toolName} ${JSON.stringify(args ?? {})}`;
}

function externalPathActionKeyFrom(args) {
  return `${args.action ?? ""} ${args.path ?? ""}`;
}

function summarizeArgs(args) {
  return excerpt(JSON.stringify(args ?? {}), 180);
}

function mergeRepeatedCounts(target, items) {
  for (const item of items ?? []) target[item.key] = (target[item.key] ?? 0) + item.count;
}

function mergeActiveNoteBodyCounts(target, source = {}) {
  for (const [id, item] of Object.entries(source)) {
    const existing = target[id];
    if (existing) {
      existing.count += item.count;
    } else {
      target[id] = { ...item };
    }
  }
}

function buildFindings(aggregate) {
  const findings = [];
  for (const item of aggregate.repeatedActiveNoteBodies) {
    findings.push({
      severity: "warning",
      area: "context-efficiency",
      message: `Repeated active-note body: ${item.key}`,
      count: item.count,
    });
  }
  for (const item of aggregate.repeatedExternalPathActions) {
    findings.push({
      severity: "warning",
      area: "tool-efficiency",
      message: `Repeated external path action: ${item.key}`,
      count: item.count,
    });
  }
  for (const item of aggregate.duplicateToolStarts) {
    findings.push({
      severity: "warning",
      area: "tool-efficiency",
      message: `Duplicate exact tool call: ${item.key}`,
      count: item.count,
    });
  }
  for (const [tool, count] of Object.entries(aggregate.toolErrorsByTool)) {
    findings.push({
      severity: "warning",
      area: "tool-errors",
      message: `Tool reported errors: ${tool}`,
      count,
    });
  }
  for (const item of aggregate.approvalDenialReasons) {
    findings.push({
      severity: "warning",
      area: "approvals",
      message: `Approval denial recorded: ${item.key}`,
      count: item.count,
    });
  }
  return findings;
}

function repeated(counts) {
  return Object.entries(counts)
    .filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => ({ key, count }));
}

function repeatedIncludingSingles(counts) {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => ({ key, count }));
}

function repeatedActiveNoteBodies(counts) {
  return Object.values(counts)
    .filter((item) => item.count > 1)
    .sort((left, right) => right.count - left.count || right.chars - left.chars || left.key.localeCompare(right.key))
    .map(({ key, count, chars }) => ({ key, count, chars }));
}

function contentText(message) {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.map((part) => (typeof part.text === "string" ? part.text : "")).join("\n");
}

function activeNotePath(text) {
  const match = text.match(/Active note "([^"]+)"/);
  return match?.[1];
}

function activeNoteBody(text) {
  const match = text.match(/Active note "([^"]+)"(?: \([^)]*\))?:\n\n([\s\S]*?)(?:\n\n---\n\n|<\/context>|$)/);
  if (!match) return null;
  const body = match[2].trimEnd();
  if (!body) return null;
  return { path: match[1], body };
}

function countActiveNoteBody(counts, item) {
  const bodyHash = hashText(item.body);
  const id = `${item.path}\0${bodyHash}`;
  const current = counts[id] ?? { key: item.path, chars: item.body.length, count: 0 };
  current.count += 1;
  counts[id] = current;
}

function hashText(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${text.length}:${(hash >>> 0).toString(16)}`;
}

function numeric(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function mutationKey(event) {
  const diff = event.diff;
  if (!diff?.kind) return null;
  const toolName = event.toolName ?? diff.kind;
  if (diff.kind === "rename") return `${toolName} ${diff.from ?? ""} -> ${diff.to ?? ""}`;
  return `${toolName} ${diff.path ?? ""}`;
}

function mutationDecisionApplies(decision) {
  return decision === "approved" || decision === "auto-approved" || decision === "denied";
}

function metricSnapshot(analysis) {
  const aggregate = analysis.aggregate ?? {};
  return {
    sessions: aggregate.sessions ?? 0,
    turns: aggregate.turns ?? 0,
    userMessages: aggregate.messages?.user ?? 0,
    assistantMessages: aggregate.messages?.assistant ?? 0,
    toolStarts: aggregate.toolStarts ?? 0,
    externalInspectStarts: aggregate.toolStartsByTool?.external_inspect ?? 0,
    cacheHits: aggregate.cacheHits ?? 0,
    toolErrors: sumCounts(aggregate.toolErrorsByTool),
    repeatedExternalPathActions: sumRepeated(aggregate.repeatedExternalPathActions),
    repeatedActiveNoteBodies: sumRepeated(aggregate.repeatedActiveNoteBodies),
    duplicateToolStarts: sumRepeated(aggregate.duplicateToolStarts),
    maxUserMessageChars: aggregate.maxUserMessageChars ?? 0,
    maxAssistantInput: aggregate.maxAssistantInput ?? 0,
    totalTokens: aggregate.usage?.totalTokens ?? 0,
    cacheReadTokens: aggregate.usage?.cacheRead ?? 0,
  };
}

function compareRepeatedItems(before, after) {
  return compareRecords(repeatedToRecord(before), repeatedToRecord(after));
}

function repeatedToRecord(items) {
  const record = {};
  for (const item of items ?? []) record[item.key] = (record[item.key] ?? 0) + item.count;
  return record;
}

function compareRecords(before = {}, after = {}) {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return keys
    .map((key) => ({ key, before: before[key] ?? 0, after: after[key] ?? 0, delta: (after[key] ?? 0) - (before[key] ?? 0) }))
    .filter((row) => row.before !== 0 || row.after !== 0 || row.delta !== 0)
    .sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta) || right.after - left.after || left.key.localeCompare(right.key));
}

function sumCounts(record = {}) {
  return Object.values(record).reduce((total, count) => total + numeric(count), 0);
}

function sumRepeated(items = []) {
  return items.reduce((total, item) => total + numeric(item.count), 0);
}

function appendCountTable(lines, heading, counts) {
  const rows = Object.entries(counts ?? {})
    .sort((left, right) => right[1] - left[1])
    .slice(0, REPORT_LIMIT)
    .map(([key, count]) => [key, count]);
  if (rows.length === 0) return;
  lines.push("", `## ${heading}`, "", markdownTable(["Key", "Count"], rows));
}

function appendRepeatedTable(lines, heading, items) {
  const rows = (items ?? []).slice(0, REPORT_LIMIT).map((item) => [item.key, item.count]);
  if (rows.length === 0) return;
  lines.push("", `## ${heading}`, "", markdownTable(["Key", "Count"], rows));
}

function appendDeltaTable(lines, heading, rows) {
  const limited = (rows ?? []).slice(0, REPORT_LIMIT).map((row) => [row.key, row.before, row.after, signed(row.delta)]);
  if (limited.length === 0) return;
  lines.push("", `## ${heading}`, "", markdownTable(["Key", "Before", "After", "Delta"], limited));
}

function appendTurnSignals(lines, files) {
  const signals = [];
  for (const file of files) {
    for (const turn of file.turns ?? []) {
      const signalCount =
        turn.cacheHits +
        sumCounts(turn.toolErrorsByTool) +
        sumRepeated(turn.repeatedExternalPathActions) +
        sumRepeated(turn.duplicateToolStarts) +
        sumRepeated(turn.approvalDenialReasons);
      if (signalCount === 0) continue;
      signals.push({
        file: path.basename(file.file ?? ""),
        turn,
        signalCount,
      });
    }
  }
  if (signals.length === 0) return;
  lines.push("", "## Turns With Signals", "");
  const sortedSignals = [...signals].sort((left, right) => right.signalCount - left.signalCount);
  for (const signal of sortedSignals.slice(0, REPORT_LIMIT)) {
    const turn = signal.turn;
    const parts = [
      `${signal.file} turn ${turn.index}`,
      `active ${turn.activeNote}`,
      `${turn.toolStarts} tool starts`,
      `${turn.cacheHits} cache hits`,
      `${turn.usage.totalTokens} tokens`,
    ];
    lines.push(`- ${parts.join("; ")}: ${turn.userExcerpt}`);
  }
}

function markdownTable(headers, rows) {
  return [
    `| ${headers.map(markdownCell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(markdownCell).join(" | ")} |`),
  ].join("\n");
}

function markdownCell(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ");
}

function signed(value) {
  return value > 0 ? `+${value}` : String(value);
}

function excerpt(text, limit = 160) {
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 3)}...`;
}
