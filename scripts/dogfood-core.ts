import { mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";

export const DOGFOOD_MANIFEST_VERSION = 1;
export const DEFAULT_DOGFOOD_SECRET = "NEXT_LEVEL_SECRET_DO_NOT_LEAK";

export interface DogfoodGeneratedNoteExpectation {
  path: string;
  frontmatter: boolean;
  requiredSubstrings: string[];
}

export interface DogfoodManifest {
  version: typeof DOGFOOD_MANIFEST_VERSION;
  runId: string;
  createdAt: string;
  vaultPath: string;
  secretText: string;
  expectedActiveNote: string;
  ignoredGlobs: string[];
  allowedMutationRoots: string[];
  deniedMutationPaths: string[];
  requiredTools: string[];
  requiredGeneratedNotes: DogfoodGeneratedNoteExpectation[];
  maxUserMessageChars: number;
}

export interface GenerateDogfoodVaultOptions {
  vaultPath: string;
  runId?: string;
  secretText?: string;
}

export interface DogfoodInvariantFinding {
  severity: "error" | "warning";
  area: string;
  message: string;
}

export interface DogfoodInvariantResult {
  ok: boolean;
  manifest: DogfoodManifest;
  sessionFiles: string[];
  metrics: {
    userMessages: number;
    assistantMessages: number;
    maxUserMessageChars: number;
    toolStarts: Record<string, number>;
    approvalDecisions: Record<string, number>;
    toolErrors: Record<string, number>;
    cacheHits: number;
    mutationApprovals: number;
    checkpoints: number;
  };
  findings: DogfoodInvariantFinding[];
}

interface SessionEntry {
  type?: string;
  message?: {
    role?: string;
    toolCallId?: string;
    toolName?: string;
    content?: Array<{ type?: string; text?: string }>;
    details?: Record<string, unknown>;
    isError?: boolean;
  };
  event?: {
    category?: string;
    action?: string;
    decision?: string;
    toolCallId?: string;
    toolName?: string;
    args?: Record<string, unknown>;
    reason?: string;
    isError?: boolean;
    diff?: ToolDiff;
  };
  checkpoint?: {
    toolCallId?: string;
  };
}

type ToolDiff =
  | { kind?: "write" | "edit" | "delete"; path?: string }
  | { kind?: "rename"; from?: string; to?: string }
  | Record<string, unknown>;

export async function generateDogfoodVault(options: GenerateDogfoodVaultOptions): Promise<DogfoodManifest> {
  const vaultPath = path.resolve(options.vaultPath);
  const runId = options.runId ?? timestampRunId();
  const secretText = options.secretText ?? DEFAULT_DOGFOOD_SECRET;
  const manifest: DogfoodManifest = {
    version: DOGFOOD_MANIFEST_VERSION,
    runId,
    createdAt: new Date().toISOString(),
    vaultPath,
    secretText,
    expectedActiveNote: "Dogfood Scratch.md",
    ignoredGlobs: ["Restricted/**", "*.secret.md"],
    allowedMutationRoots: ["Generated/", "Adversarial Output/", "Imported/", "Long Workflow/"],
    deniedMutationPaths: [
      "Generated/Denied Should Not Exist.md",
      "Generated/Closed Approval Should Not Exist.md",
      "Generated/Settings Race Denied Should Not Exist.md",
      "Generated/Batch First Should Not Exist.md",
    ],
    requiredTools: [
      "read",
      "vault_inspect",
      "write",
      "edit",
      "rename",
      "delete",
      "set_properties",
      "search_memory",
      "ask_user",
    ],
    requiredGeneratedNotes: [
      {
        path: "Generated/Oracle.md",
        frontmatter: true,
        requiredSubstrings: ["# Oracle", "[[Generated/Oracle Companion]]", "verified: true"],
      },
      {
        path: "Generated/Oracle Companion.md",
        frontmatter: true,
        requiredSubstrings: ["# Oracle Companion"],
      },
      {
        path: "Generated/Reload Continuation.md",
        frontmatter: true,
        requiredSubstrings: ["plugin reload"],
      },
      {
        path: "Generated/Double Click Approval.md",
        frontmatter: true,
        requiredSubstrings: ["Approved once despite a double click."],
      },
      {
        path: "Generated/Settings Race Allowed.md",
        frontmatter: true,
        requiredSubstrings: ["The in-flight modal decision won."],
      },
      {
        path: "Generated/Batch Second.md",
        frontmatter: true,
        requiredSubstrings: ["The second batch mutation still asked before running."],
      },
      {
        path: "Generated/New Session Continuation.md",
        frontmatter: true,
        requiredSubstrings: ["Scripted replay continued after /new."],
      },
    ],
    maxUserMessageChars: 2_500,
  };

  await mkdir(vaultPath, { recursive: true });
  await seedVault(vaultPath, manifest);
  await writeManifest(manifest);
  return manifest;
}

export async function loadDogfoodManifest(manifestPath: string): Promise<DogfoodManifest> {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as DogfoodManifest;
  if (manifest.version !== DOGFOOD_MANIFEST_VERSION) {
    throw new Error(`Unsupported dogfood manifest version: ${manifest.version}`);
  }
  return {
    ...manifest,
    vaultPath: path.resolve(manifest.vaultPath),
  };
}

export async function assertDogfoodInvariants(manifestOrPath: DogfoodManifest | string): Promise<DogfoodInvariantResult> {
  const manifest = typeof manifestOrPath === "string" ? await loadDogfoodManifest(manifestOrPath) : manifestOrPath;
  const sessionFiles = await sessionJsonlFiles(manifest.vaultPath);
  const entries = await readSessionEntries(sessionFiles);
  const findings: DogfoodInvariantFinding[] = [];
  const metrics = emptyInvariantMetrics();
  const tracking = createToolCallTracking();

  if (sessionFiles.length === 0) {
    findings.push(error("sessions", "No session JSONL files were produced."));
  }

  for (const entry of entries) {
    collectEntryInvariants(entry, manifest, findings, metrics, tracking);
  }

  appendRequiredToolFindings(findings, manifest, metrics.toolStarts);
  appendCheckpointFindings(findings, tracking);
  appendContextFindings(findings, manifest, metrics.maxUserMessageChars);
  await appendDeniedMutationFindings(findings, manifest);
  await appendGeneratedNoteFindings(findings, manifest);

  const result: DogfoodInvariantResult = {
    ok: findings.every((finding) => finding.severity !== "error"),
    manifest,
    sessionFiles,
    metrics,
    findings,
  };
  return result;
}

interface ToolCallTracking {
  approvedMutationToolCalls: Set<string>;
  createdSkillToolCalls: Set<string>;
  checkpointToolCalls: Set<string>;
  completedToolCalls: Set<string>;
}

type InvariantMetrics = DogfoodInvariantResult["metrics"];

function emptyInvariantMetrics(): InvariantMetrics {
  return {
    userMessages: 0,
    assistantMessages: 0,
    maxUserMessageChars: 0,
    toolStarts: {},
    approvalDecisions: {},
    toolErrors: {},
    cacheHits: 0,
    mutationApprovals: 0,
    checkpoints: 0,
  };
}

function createToolCallTracking(): ToolCallTracking {
  return {
    approvedMutationToolCalls: new Set<string>(),
    createdSkillToolCalls: new Set<string>(),
    checkpointToolCalls: new Set<string>(),
    completedToolCalls: new Set<string>(),
  };
}

function collectEntryInvariants(
  entry: SessionEntry,
  manifest: DogfoodManifest,
  findings: DogfoodInvariantFinding[],
  metrics: InvariantMetrics,
  tracking: ToolCallTracking,
): void {
  if (JSON.stringify(entry).includes(manifest.secretText)) {
    findings.push(error("privacy", "Restricted secret marker leaked into session JSONL."));
  }

  if (entry.type === "message") {
    collectMessageInvariants(entry, findings, metrics);
    return;
  }

  if (entry.type === "file_checkpoint" && entry.checkpoint?.toolCallId) {
    tracking.checkpointToolCalls.add(entry.checkpoint.toolCallId);
    metrics.checkpoints += 1;
    return;
  }

  if (entry.event) collectEventInvariants(entry.event, manifest, findings, metrics, tracking);
}

function collectMessageInvariants(
  entry: SessionEntry,
  findings: DogfoodInvariantFinding[],
  metrics: InvariantMetrics,
): void {
  const message = entry.message ?? {};
  if (message.role === "user") recordUserMessageInvariants(message, findings, metrics);
  if (message.role === "assistant") metrics.assistantMessages += 1;
  if (message.role === "toolResult" && message.details?.cached === true) metrics.cacheHits += 1;
}

function recordUserMessageInvariants(
  message: NonNullable<SessionEntry["message"]>,
  findings: DogfoodInvariantFinding[],
  metrics: InvariantMetrics,
): void {
  metrics.userMessages += 1;
  const text = contentText(message.content);
  metrics.maxUserMessageChars = Math.max(metrics.maxUserMessageChars, text.length);
  if (text.includes("Restricted/") || text.includes("Secret.secret.md")) {
    findings.push(error("privacy", "Ignored active-note path leaked into user prompt context."));
  }
  if (text.includes("Agentic Chat Exports/")) {
    findings.push(error("context", "Exported session note became active prompt context."));
  }
}

function collectEventInvariants(
  event: NonNullable<SessionEntry["event"]>,
  manifest: DogfoodManifest,
  findings: DogfoodInvariantFinding[],
  metrics: InvariantMetrics,
  tracking: ToolCallTracking,
): void {
  if (event.category === "tool_call" && event.action === "start" && event.toolName) {
    metrics.toolStarts[event.toolName] = (metrics.toolStarts[event.toolName] ?? 0) + 1;
  }
  if (event.category === "tool_call" && event.action === "end" && event.toolName) {
    recordToolEndInvariants(event, event.toolName, metrics, tracking);
  }
  if (event.category === "approval" && event.action === "decision" && event.toolName && event.decision) {
    recordApprovalInvariants(event, event.toolName, event.decision, manifest, findings, metrics, tracking);
  }
}

function recordToolEndInvariants(
  event: NonNullable<SessionEntry["event"]>,
  toolName: string,
  metrics: InvariantMetrics,
  tracking: ToolCallTracking,
): void {
  if (event.toolCallId) tracking.completedToolCalls.add(event.toolCallId);
  if (event.isError) metrics.toolErrors[toolName] = (metrics.toolErrors[toolName] ?? 0) + 1;
}

function recordApprovalInvariants(
  event: NonNullable<SessionEntry["event"]>,
  toolName: string,
  decision: string,
  manifest: DogfoodManifest,
  findings: DogfoodInvariantFinding[],
  metrics: InvariantMetrics,
  tracking: ToolCallTracking,
): void {
  const key = `${toolName}:${decision}`;
  metrics.approvalDecisions[key] = (metrics.approvalDecisions[key] ?? 0) + 1;
  const touched = diffPaths(event.diff);
  if (decision === "approved" || decision === "auto-approved") {
    recordApprovedDecisionInvariants(event, toolName, touched, manifest, findings, metrics, tracking);
  }
  if (decision === "denied") {
    recordDeniedDecisionInvariants(touched, manifest, findings);
  }
}

function recordApprovedDecisionInvariants(
  event: NonNullable<SessionEntry["event"]>,
  toolName: string,
  touched: string[],
  manifest: DogfoodManifest,
  findings: DogfoodInvariantFinding[],
  metrics: InvariantMetrics,
  tracking: ToolCallTracking,
): void {
  if (touched.length > 0) {
    metrics.mutationApprovals += 1;
    if (event.toolCallId) tracking.approvedMutationToolCalls.add(event.toolCallId);
  }
  // create_skill writes vault packages but captures no file checkpoint by
  // design (not undoable) — track separately so the checkpoint invariant
  // below doesn't fire, and audit it as its own finding instead.
  if (toolName === "create_skill" && event.toolCallId) {
    tracking.createdSkillToolCalls.add(event.toolCallId);
  }
  for (const targetPath of touched) {
    if (!isAllowedMutationPath(targetPath, manifest.allowedMutationRoots)) {
      findings.push(error("approvals", `Approved mutation outside allowed roots: ${targetPath}`));
    }
  }
}

function recordDeniedDecisionInvariants(
  touched: string[],
  manifest: DogfoodManifest,
  findings: DogfoodInvariantFinding[],
): void {
  for (const targetPath of touched) {
    if (!manifest.deniedMutationPaths.includes(targetPath) && !isAllowedMutationPath(targetPath, manifest.allowedMutationRoots)) {
      findings.push(warning("approvals", `Denied mutation targeted an unexpected path: ${targetPath}`));
    }
  }
}

function appendRequiredToolFindings(
  findings: DogfoodInvariantFinding[],
  manifest: DogfoodManifest,
  toolStarts: Record<string, number>,
): void {
  for (const tool of manifest.requiredTools) {
    if (!toolStarts[tool]) findings.push(error("tool-coverage", `Required tool was not exercised: ${tool}`));
  }
}

function appendCheckpointFindings(findings: DogfoodInvariantFinding[], tracking: ToolCallTracking): void {
  for (const toolCallId of tracking.approvedMutationToolCalls) {
    appendApprovedMutationFollowUpFindings(findings, toolCallId, tracking);
  }
  for (const toolCallId of tracking.createdSkillToolCalls) {
    appendCreatedSkillFollowUpFindings(findings, toolCallId, tracking);
  }
}

function appendApprovedMutationFollowUpFindings(
  findings: DogfoodInvariantFinding[],
  toolCallId: string,
  tracking: ToolCallTracking,
): void {
  // create_skill is audited separately below (no checkpoint by design).
  if (tracking.createdSkillToolCalls.has(toolCallId)) return;
  if (!tracking.checkpointToolCalls.has(toolCallId)) {
    findings.push(error("checkpoints", `Approved mutation ${toolCallId} did not capture a file checkpoint.`));
  }
  if (!tracking.completedToolCalls.has(toolCallId)) {
    findings.push(error("tool-results", `Approved mutation ${toolCallId} did not record a final tool result.`));
  }
}

function appendCreatedSkillFollowUpFindings(
  findings: DogfoodInvariantFinding[],
  toolCallId: string,
  tracking: ToolCallTracking,
): void {
  if (!tracking.completedToolCalls.has(toolCallId)) {
    findings.push(error("tool-results", `Approved create_skill ${toolCallId} did not record a final tool result.`));
  }
}

function appendContextFindings(
  findings: DogfoodInvariantFinding[],
  manifest: DogfoodManifest,
  maxUserMessageChars: number,
): void {
  if (maxUserMessageChars > manifest.maxUserMessageChars) {
    findings.push(error("context", `Max user message was ${maxUserMessageChars} chars, over limit ${manifest.maxUserMessageChars}.`));
  }
}

async function appendDeniedMutationFindings(
  findings: DogfoodInvariantFinding[],
  manifest: DogfoodManifest,
): Promise<void> {
  for (const deniedPath of manifest.deniedMutationPaths) {
    if (await exists(path.join(manifest.vaultPath, deniedPath))) {
      findings.push(error("approvals", `Denied mutation created ${deniedPath}.`));
    }
  }
}

async function appendGeneratedNoteFindings(
  findings: DogfoodInvariantFinding[],
  manifest: DogfoodManifest,
): Promise<void> {
  for (const expected of manifest.requiredGeneratedNotes) {
    await appendGeneratedNoteFinding(findings, manifest, expected);
  }
}

async function appendGeneratedNoteFinding(
  findings: DogfoodInvariantFinding[],
  manifest: DogfoodManifest,
  expected: DogfoodGeneratedNoteExpectation,
): Promise<void> {
  const notePath = path.join(manifest.vaultPath, expected.path);
  if (!(await exists(notePath))) {
    findings.push(error("generated-notes", `Required generated note is missing: ${expected.path}`));
    return;
  }
  const content = await readFile(notePath, "utf8");
  appendGeneratedNoteContentFindings(findings, manifest, expected, content);
  await appendGeneratedNoteLinkFindings(findings, manifest, expected, content);
}

function appendGeneratedNoteContentFindings(
  findings: DogfoodInvariantFinding[],
  manifest: DogfoodManifest,
  expected: DogfoodGeneratedNoteExpectation,
  content: string,
): void {
  if (content.includes(manifest.secretText)) {
    findings.push(error("privacy", `Restricted secret marker leaked into generated note ${expected.path}.`));
  }
  if (expected.frontmatter && !content.startsWith("---\n")) {
    findings.push(error("generated-notes", `Generated note lacks YAML frontmatter: ${expected.path}`));
  }
  for (const required of expected.requiredSubstrings) {
    if (!content.includes(required)) {
      findings.push(error("generated-notes", `Generated note ${expected.path} is missing required text: ${required}`));
    }
  }
}

async function appendGeneratedNoteLinkFindings(
  findings: DogfoodInvariantFinding[],
  manifest: DogfoodManifest,
  expected: DogfoodGeneratedNoteExpectation,
  content: string,
): Promise<void> {
  for (const link of wikiLinks(content)) {
    if (!(await wikiTargetExists(manifest.vaultPath, link))) {
      findings.push(error("links", `Generated note ${expected.path} has a broken link: [[${link}]]`));
    }
  }
}

export async function writeDogfoodRunReport(result: DogfoodInvariantResult, outputDir = "logs/dogfood-runs"): Promise<string> {
  await mkdir(outputDir, { recursive: true });
  const reportPath = path.join(outputDir, `${result.manifest.runId}-summary.md`);
  await writeFile(reportPath, formatDogfoodReport(result), "utf8");
  return reportPath;
}

export function formatDogfoodReport(result: DogfoodInvariantResult): string {
  const lines = [
    `# Dogfood Run ${result.manifest.runId}`,
    "",
    `Status: ${result.ok ? "pass" : "fail"}`,
    `Created: ${result.manifest.createdAt}`,
    `Vault: ${result.manifest.vaultPath}`,
    "",
    "## Sessions",
    ...result.sessionFiles.map((file) => `- ${file}`),
    "",
    "## Metrics",
    `- User messages: ${result.metrics.userMessages}`,
    `- Assistant messages: ${result.metrics.assistantMessages}`,
    `- Max user message chars: ${result.metrics.maxUserMessageChars}`,
    `- Cache hits: ${result.metrics.cacheHits}`,
    `- Mutation approvals: ${result.metrics.mutationApprovals}`,
    `- Checkpoints: ${result.metrics.checkpoints}`,
    "",
    "## Tool Starts",
    ...objectRows(result.metrics.toolStarts),
    "",
    "## Approval Decisions",
    ...objectRows(result.metrics.approvalDecisions),
    "",
    "## Tool Errors",
    ...objectRows(result.metrics.toolErrors),
    "",
    "## Findings",
    ...(result.findings.length === 0
      ? ["- none"]
      : result.findings.map((finding) => `- ${finding.severity.toUpperCase()} [${finding.area}] ${finding.message}`)),
    "",
    "## Rough-Edge Follow-Ups",
    ...roughEdgeFollowUps(result),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

export async function writeManifest(manifest: DogfoodManifest): Promise<string> {
  const manifestPath = path.join(manifest.vaultPath, ".dogfood", "manifest.json");
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifestPath;
}

async function seedVault(vaultPath: string, manifest: DogfoodManifest): Promise<void> {
  await mkdir(path.join(vaultPath, ".obsidian"), { recursive: true });
  await writeText(vaultPath, "Dogfood Scratch.md", "# Next-Level Dogfood Scratch\n\nSafe active note for adversarial dogfood.\n");
  await mkdir(path.join(vaultPath, "Empty"), { recursive: true });
  await writeText(vaultPath, "Messy/Home.md", "---\ntags: [messy]\n---\n# Messy Home\nSee [[Messy/Target]]. OAuth duplicate cleanup.\n");
  await writeText(vaultPath, "Messy/Target.md", "# Target\nBacklink target for generated local graph checks.\n");
  await writeText(vaultPath, "Messy/Duplicate stale.md", "# Duplicate\nDelete me only when explicitly scoped.\n");
  await writeText(vaultPath, "Generated/Delete Me.md", "---\ntags: [dogfood, stale]\n---\n# Delete Me\nAllowed delete target.\n");
  await writeText(vaultPath, "Messy/Broken Link.md", "# Broken Link\nThis deliberately points at [[Missing/Nowhere]].\n");
  await writeText(vaultPath, "Large/Huge.md", `# Huge\n\n${Array.from({ length: 400 }, (_, index) => `Line ${index + 1} OAuth and cache context`).join("\n")}\n`);
  await writeText(vaultPath, "Restricted/Secret.secret.md", `# Secret\n${manifest.secretText}\n`);
  await writeText(vaultPath, "Multilingual/Arvizturo tukorfurogep.md", "# Arvizturo\nMultilingual workspace note with English und magyar content.\n");
  await writeText(vaultPath, "Odd Files/Invalid Frontmatter.md", "---\nstatus: [unterminated\n---\n# Invalid Frontmatter\nUseful despite bad YAML.\n");
  await writeText(vaultPath, "Odd Files/Name With Spaces.md", "# Name With Spaces\nPath handling fixture.\n");
  await writeText(vaultPath, "Stale Generated/Old Output.md", "---\ntags: [dogfood, stale]\n---\n# Old Output\nShould not be treated as current run evidence.\n");
  await writeText(vaultPath, "Agentic Chat Exports/Fake Export.md", "# Fake Export\nThis must not become active context.\n");
  await writeText(vaultPath, ".obsidian/plugins/agentic-chat/memory/memories.jsonl", `${JSON.stringify({
    id: "mem-next-level-devops",
    kind: "fact",
    scope: "vault",
    text: "Next-level dogfood is validating a DevOps knowledge-base workflow.",
    enabled: true,
    createdAt: manifest.createdAt,
  })}\n${JSON.stringify({
    id: "mem-next-level-conflict",
    kind: "fact",
    scope: "vault",
    text: "Conflicting memory says generated notes should be ignored.",
    enabled: false,
    forgottenAt: manifest.createdAt,
    createdAt: manifest.createdAt,
  })}\n`);
}

async function writeText(root: string, relativePath: string, content: string): Promise<void> {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

async function sessionJsonlFiles(vaultPath: string): Promise<string[]> {
  const sessionDir = path.join(vaultPath, ".obsidian/plugins/agentic-chat/sessions");
  if (!(await exists(sessionDir))) return [];
  return (await readdir(sessionDir))
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .map((name) => path.join(sessionDir, name));
}

async function readSessionEntries(sessionFiles: string[]): Promise<SessionEntry[]> {
  const entries: SessionEntry[] = [];
  for (const file of sessionFiles) {
    const raw = await readFile(file, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      entries.push(JSON.parse(line) as SessionEntry);
    }
  }
  return entries;
}

function contentText(content: Array<{ text?: string }> | undefined): string {
  return (content ?? []).map((part) => part.text ?? "").join("\n");
}

function diffPaths(diff: ToolDiff | undefined): string[] {
  if (!diff || typeof diff !== "object") return [];
  if (diff.kind === "rename") return [stringValue(diff.from), stringValue(diff.to)].filter(Boolean);
  const targetPath = "path" in diff ? stringValue(diff.path) : "";
  return targetPath ? [targetPath] : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isAllowedMutationPath(targetPath: string, roots: string[]): boolean {
  return roots.some((root) => targetPath === root.replace(/\/$/, "") || targetPath.startsWith(root));
}

function wikiLinks(content: string): string[] {
  const links: string[] = [];
  const pattern = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
  for (const match of content.matchAll(pattern)) {
    links.push(match[1]);
  }
  return links;
}

async function wikiTargetExists(vaultPath: string, link: string): Promise<boolean> {
  const normalized = link.endsWith(".md") ? link : `${link}.md`;
  if (await exists(path.join(vaultPath, normalized))) return true;
  const basename = path.basename(normalized);
  return (await findVaultMarkdownFiles(vaultPath)).some((file) => path.basename(file) === basename);
}

async function findVaultMarkdownFiles(vaultPath: string): Promise<string[]> {
  const results: string[] = [];
  await walk(vaultPath, async (file) => {
    if (file.endsWith(".md")) results.push(path.relative(vaultPath, file).replace(/\\/g, "/"));
  });
  return results;
}

async function walk(root: string, visit: (file: string) => Promise<void>): Promise<void> {
  if (!(await exists(root))) return;
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.name === ".obsidian") continue;
    if (entry.isDirectory()) await walk(full, visit);
    else if (entry.isFile()) await visit(full);
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

function objectRows(values: Record<string, number>): string[] {
  const entries = Object.entries(values).sort((a, b) => b[1] - a[1]);
  return entries.length === 0 ? ["- none"] : entries.map(([key, value]) => `- ${key}: ${value}`);
}

function roughEdgeFollowUps(result: DogfoodInvariantResult): string[] {
  const failedTools = Object.entries(result.metrics.toolErrors).sort((a, b) => b[1] - a[1]);
  const rows = [
    failedTools.length
      ? `- Review expected vs unexpected tool errors: ${failedTools.map(([key, count]) => `${key} (${count})`).join(", ")}.`
      : "- No tool errors were recorded.",
    result.metrics.maxUserMessageChars > result.manifest.maxUserMessageChars * 0.8
      ? "- User prompt context is near the configured size threshold; inspect active-note context packing."
      : "- User prompt context stayed comfortably below the threshold.",
  ];
  if (!result.ok) rows.unshift("- Convert each invariant failure into a deterministic regression or product fix.");
  return rows;
}

function error(area: string, message: string): DogfoodInvariantFinding {
  return { severity: "error", area, message };
}

function warning(area: string, message: string): DogfoodInvariantFinding {
  return { severity: "warning", area, message };
}

function timestampRunId(): string {
  return `dogfood-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

export async function canonicalPath(target: string): Promise<string> {
  return await realpath(path.resolve(target));
}
