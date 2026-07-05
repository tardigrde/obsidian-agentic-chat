import { mkdir, readFile, readdir, realpath, stat, symlink, writeFile } from "node:fs/promises";
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
  externalRoot: string;
  secretText: string;
  expectedActiveNote: string;
  ignoredGlobs: string[];
  allowedMutationRoots: string[];
  deniedMutationPaths: string[];
  requiredTools: string[];
  requiredGeneratedNotes: DogfoodGeneratedNoteExpectation[];
  repeatedExternalReads: Array<{ path: string; minCount: number }>;
  maxRepeatedExternalReadCount?: number;
  maxUserMessageChars: number;
}

export interface GenerateDogfoodVaultOptions {
  vaultPath: string;
  externalRoot: string;
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
    repeatedExternalReads: Record<string, number>;
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
  const externalRoot = path.resolve(options.externalRoot);
  const runId = options.runId ?? timestampRunId();
  const secretText = options.secretText ?? DEFAULT_DOGFOOD_SECRET;
  const manifest: DogfoodManifest = {
    version: DOGFOOD_MANIFEST_VERSION,
    runId,
    createdAt: new Date().toISOString(),
    vaultPath,
    externalRoot,
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
      "external_inspect",
      "search_memory",
      "ask_user",
    ],
    requiredGeneratedNotes: [
      {
        path: "Generated/Oracle.md",
        frontmatter: true,
        requiredSubstrings: ["source: external://foreign-vault/Imported.md", "[[Generated/Oracle Companion]]", "verified: true"],
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
    repeatedExternalReads: [{ path: "foreign-vault/Imported.md", minCount: 2 }],
    maxUserMessageChars: 2_500,
  };

  await mkdir(vaultPath, { recursive: true });
  await mkdir(externalRoot, { recursive: true });
  await seedVault(vaultPath, manifest);
  await seedExternalRoot(externalRoot, secretText);
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
    externalRoot: path.resolve(manifest.externalRoot),
  };
}

export async function assertDogfoodInvariants(manifestOrPath: DogfoodManifest | string): Promise<DogfoodInvariantResult> {
  const manifest = typeof manifestOrPath === "string" ? await loadDogfoodManifest(manifestOrPath) : manifestOrPath;
  const sessionFiles = await sessionJsonlFiles(manifest.vaultPath);
  const entries = await readSessionEntries(sessionFiles);
  const findings: DogfoodInvariantFinding[] = [];
  const toolStarts: Record<string, number> = {};
  const approvalDecisions: Record<string, number> = {};
  const toolErrors: Record<string, number> = {};
  const repeatedExternalReads: Record<string, number> = {};
  const approvedMutationToolCalls = new Set<string>();
  const checkpointToolCalls = new Set<string>();
  const completedToolCalls = new Set<string>();
  let userMessages = 0;
  let assistantMessages = 0;
  let maxUserMessageChars = 0;
  let cacheHits = 0;
  let mutationApprovals = 0;
  let checkpoints = 0;

  if (sessionFiles.length === 0) {
    findings.push(error("sessions", "No session JSONL files were produced."));
  }

  for (const entry of entries) {
    const serialized = JSON.stringify(entry);
    if (serialized.includes(manifest.secretText)) {
      findings.push(error("privacy", "Restricted secret marker leaked into session JSONL."));
    }

    if (entry.type === "message") {
      const message = entry.message ?? {};
      if (message.role === "user") {
        userMessages += 1;
        const text = contentText(message.content);
        maxUserMessageChars = Math.max(maxUserMessageChars, text.length);
        if (text.includes("Restricted/") || text.includes("Secret.secret.md")) {
          findings.push(error("privacy", "Ignored active-note path leaked into user prompt context."));
        }
        if (text.includes("Agentic Chat Exports/")) {
          findings.push(error("context", "Exported session note became active prompt context."));
        }
      }
      if (message.role === "assistant") assistantMessages += 1;
      if (message.role === "toolResult" && message.details?.cached === true) cacheHits += 1;
      continue;
    }

    if (entry.type === "file_checkpoint" && entry.checkpoint?.toolCallId) {
      checkpointToolCalls.add(entry.checkpoint.toolCallId);
      checkpoints += 1;
      continue;
    }

    const event = entry.event;
    if (!event) continue;

    if (event.category === "tool_call" && event.action === "start" && event.toolName) {
      toolStarts[event.toolName] = (toolStarts[event.toolName] ?? 0) + 1;
      if (event.toolName === "external_inspect") {
        const action = typeof event.args?.action === "string" ? event.args.action : "";
        const targetPath = typeof event.args?.path === "string" ? event.args.path : "";
        if (action === "read") repeatedExternalReads[targetPath] = (repeatedExternalReads[targetPath] ?? 0) + 1;
      }
    }

    if (event.category === "tool_call" && event.action === "end" && event.toolName) {
      if (event.toolCallId) completedToolCalls.add(event.toolCallId);
      if (event.isError) toolErrors[event.toolName] = (toolErrors[event.toolName] ?? 0) + 1;
    }

    if (event.category === "approval" && event.action === "decision" && event.toolName && event.decision) {
      const key = `${event.toolName}:${event.decision}`;
      approvalDecisions[key] = (approvalDecisions[key] ?? 0) + 1;
      const touched = diffPaths(event.diff);
      if (event.decision === "approved" || event.decision === "auto-approved") {
        if (touched.length > 0) {
          mutationApprovals += 1;
          if (event.toolCallId) approvedMutationToolCalls.add(event.toolCallId);
        }
        for (const targetPath of touched) {
          if (!isAllowedMutationPath(targetPath, manifest.allowedMutationRoots)) {
            findings.push(error("approvals", `Approved mutation outside allowed roots: ${targetPath}`));
          }
        }
      }
      if (event.decision === "denied") {
        for (const targetPath of touched) {
          if (!manifest.deniedMutationPaths.includes(targetPath) && !isAllowedMutationPath(targetPath, manifest.allowedMutationRoots)) {
            findings.push(warning("approvals", `Denied mutation targeted an unexpected path: ${targetPath}`));
          }
        }
      }
    }
  }

  for (const tool of manifest.requiredTools) {
    if (!toolStarts[tool]) findings.push(error("tool-coverage", `Required tool was not exercised: ${tool}`));
  }

  for (const toolCallId of approvedMutationToolCalls) {
    if (!checkpointToolCalls.has(toolCallId)) {
      findings.push(error("checkpoints", `Approved mutation ${toolCallId} did not capture a file checkpoint.`));
    }
    if (!completedToolCalls.has(toolCallId)) {
      findings.push(error("tool-results", `Approved mutation ${toolCallId} did not record a final tool result.`));
    }
  }

  if (maxUserMessageChars > manifest.maxUserMessageChars) {
    findings.push(error("context", `Max user message was ${maxUserMessageChars} chars, over limit ${manifest.maxUserMessageChars}.`));
  }

  for (const expected of manifest.repeatedExternalReads) {
    const count = repeatedExternalReads[expected.path] ?? 0;
    if (count < expected.minCount) {
      findings.push(error("cache", `Expected ${expected.path} to be read at least ${expected.minCount} times; saw ${count}.`));
    }
  }
  if (manifest.repeatedExternalReads.length > 0 && cacheHits === 0) {
    findings.push(error("cache", "No visible cached tool result was recorded."));
  }
  if (manifest.maxRepeatedExternalReadCount !== undefined) {
    for (const [targetPath, count] of Object.entries(repeatedExternalReads)) {
      if (count > manifest.maxRepeatedExternalReadCount) {
        findings.push(
          warning(
            "tool-efficiency",
            `External read ${targetPath} was repeated ${count} times, over warning threshold ${manifest.maxRepeatedExternalReadCount}.`,
          ),
        );
      }
    }
  }

  for (const deniedPath of manifest.deniedMutationPaths) {
    if (await exists(path.join(manifest.vaultPath, deniedPath))) {
      findings.push(error("approvals", `Denied mutation created ${deniedPath}.`));
    }
  }

  for (const expected of manifest.requiredGeneratedNotes) {
    const notePath = path.join(manifest.vaultPath, expected.path);
    if (!(await exists(notePath))) {
      findings.push(error("generated-notes", `Required generated note is missing: ${expected.path}`));
      continue;
    }
    const content = await readFile(notePath, "utf8");
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
    for (const link of wikiLinks(content)) {
      if (!(await wikiTargetExists(manifest.vaultPath, link))) {
        findings.push(error("links", `Generated note ${expected.path} has a broken link: [[${link}]]`));
      }
    }
  }

  const result: DogfoodInvariantResult = {
    ok: findings.every((finding) => finding.severity !== "error"),
    manifest,
    sessionFiles,
    metrics: {
      userMessages,
      assistantMessages,
      maxUserMessageChars,
      toolStarts,
      approvalDecisions,
      toolErrors,
      repeatedExternalReads,
      cacheHits,
      mutationApprovals,
      checkpoints,
    },
    findings,
  };
  return result;
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
    `External root: ${result.manifest.externalRoot}`,
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
    "## Repeated External Reads",
    ...objectRows(result.metrics.repeatedExternalReads),
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

async function seedExternalRoot(externalRoot: string, secretText: string): Promise<void> {
  await writeText(externalRoot, "foreign-vault/Imported.md", "# Imported\n\nThis is a migration source note for synthetic dogfood.\n");
  await writeText(externalRoot, "repos/service-a/README.md", "# service-a\n\nDevOps service with Kubernetes, Terraform, and CI notes.\n");
  await writeText(externalRoot, "repos/service-a/package.json", "{\n  \"name\": \"service-a\",\n  \"scripts\": { \"test\": \"vitest\" }\n}\n");
  await writeText(externalRoot, "repos/service-a/.gitignore", "ignored-by-git.txt\n");
  await writeText(externalRoot, "repos/service-a/ignored-by-git.txt", "This should be hidden when honorGitignore is true.\n");
  await writeText(externalRoot, "repos/service-b/Chart.yaml", "apiVersion: v2\nname: service-b\nversion: 0.1.0\n");
  await writeText(externalRoot, "secrets/.env", `TOKEN=${secretText}\n`);
  await createSymlinkIfPossible(externalRoot, "repos/service-a/self-root-link", externalRoot);
}

async function writeText(root: string, relativePath: string, content: string): Promise<void> {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

async function createSymlinkIfPossible(root: string, relativePath: string, target: string): Promise<void> {
  const linkPath = path.join(root, relativePath);
  try {
    await mkdir(path.dirname(linkPath), { recursive: true });
    await symlink(target, linkPath, "dir");
  } catch {
    // Symlinks are an adversarial bonus, not a required fixture on every platform.
  }
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
  const repeated = Object.entries(result.metrics.repeatedExternalReads)
    .filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1]);
  const failedTools = Object.entries(result.metrics.toolErrors).sort((a, b) => b[1] - a[1]);
  const rows = [
    repeated.length
      ? `- Review repeated external reads: ${repeated.map(([key, count]) => `${key} (${count})`).join(", ")}.`
      : "- No repeated external reads crossed the reporting threshold.",
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
