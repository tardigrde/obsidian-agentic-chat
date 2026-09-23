/**
 * Plan-as-artifact model for plan mode (Phase B of the plan-mode redesign).
 *
 * The plan is a structured, editable, persistable object — not raw chat text.
 * Detection replaces the fragile literal `PLAN_COMPLETE` suffix handshake as
 * the primary trigger (the marker is still stripped for backward tolerance):
 * the UI detects a structured plan block (a `<plan>` section or
 * heading-plus-steps markdown) at turn end and renders an inline plan card.
 *
 * The plan id is stable across revisions (feedback survives in-place plan
 * revisions; transient state resets only on a new id) — the obsidian-copilot
 * `CurrentPlan` pattern.
 *
 * Persistence is plugin-private JSON only for now. Saving plans as real vault
 * notes (`vault/plans/`) is deliberately deferred: note-save affects the
 * user's vault, which the owner hasn't approved yet.
 */

import type { AgentMode } from "./modes";

export type PlanArtifactStatus = "pending" | "approved" | "rejected" | "executing" | "implemented";

export interface PlanStep {
  title: string;
  /** File, folder, or scope tag mentioned for this step (e.g. a backticked path). */
  scope?: string;
}

export interface PlanArtifact {
  /** Stable across revisions of the same plan; a new id resets transient state. */
  id: string;
  /** Bumped on every in-place revision of the same plan id. */
  revision: number;
  title: string;
  steps: PlanStep[];
  /** Distinct vault paths referenced across the plan (for the scope recap). */
  scopeFiles: string[];
  /** The plan markdown the artifact was extracted from (editable source). */
  rawMarkdown: string;
  createdAt: string;
  status: PlanArtifactStatus;
  /** Unsent feedback typed into the card; survives in-place revisions. */
  feedbackDraft?: string;
  /** Hash of the source message, so a manually-marked plan can be re-found. */
  messageHash?: string;
  /**
   * Posture the session held when the plan was drafted. Persisted with the
   * artifact so auto-apply eligibility survives restarts (the in-memory
   * per-session posture memory does not).
   */
  originPosture?: AgentMode | null;
}

/** Legacy completion handshake: kept as backward tolerance, not the trigger. */
export const PLAN_COMPLETE_MARKER = "PLAN_COMPLETE";

export function hasPlanCompleteMarker(text: string): boolean {
  return !!text?.trim().endsWith(PLAN_COMPLETE_MARKER);
}

/** Strip a trailing legacy `PLAN_COMPLETE` line before render/detection. */
export function stripPlanCompleteMarker(text: string): string {
  if (!hasPlanCompleteMarker(text)) return text;
  return text.trim().replace(/\n?PLAN_COMPLETE\s*$/, "");
}

export interface DetectedPlanBody {
  title: string;
  steps: PlanStep[];
  scopeFiles: string[];
  rawMarkdown: string;
}

/**
 * Detect a structured plan in model output. Returns the extracted body, or
 * null when the text is not plan-shaped. Triggers, in order:
 * 1. an explicit `<plan>…</plan>` block;
 * 2. the legacy `PLAN_COMPLETE` suffix plus at least one list item;
 * 3. a plan heading (`# …plan…`) plus at least two list items;
 * 4. at least three numbered steps even without a heading.
 */
export function detectPlanBody(text: string): DetectedPlanBody | null {
  const hadMarker = hasPlanCompleteMarker(text);
  const clean = stripPlanCompleteMarker(text).trim();
  if (!clean) return null;
  const fenced = extractFencedPlanBlock(clean);
  const body = (fenced ?? clean).trim();
  const lines = body.split("\n");
  const title = extractPlanTitle(lines);
  const steps = extractPlanSteps(lines);
  const scopeFiles = extractScopeFiles(body);
  if (fenced) {
    if (steps.length === 0) return null;
    return { title, steps, scopeFiles, rawMarkdown: fenced.trim() };
  }
  if (hadMarker && steps.length >= 1) return { title, steps, scopeFiles, rawMarkdown: body };
  if (hasPlanHeading(lines) && steps.length >= 2) return { title, steps, scopeFiles, rawMarkdown: body };
  if (countNumberedSteps(lines) >= 3) return { title, steps, scopeFiles, rawMarkdown: body };
  return null;
}

/** Manual fallback: capture any assistant message as a plan artifact. */
export function manualPlanBody(text: string): DetectedPlanBody | null {
  const lines = text.trim().split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  const title = (lines[0] ?? "Proposed plan").slice(0, 120);
  const steps: PlanStep[] = lines.slice(1, 21).map((line) => {
    const cleaned = line.replace(/^([-*+]|\d+[.)])\s+/, "");
    const scope = /`([^`]+)`/.exec(cleaned)?.[1]?.trim() || undefined;
    return scope ? { title: cleaned.slice(0, 300), scope } : { title: cleaned.slice(0, 300) };
  });
  return { title, steps, scopeFiles: extractScopeFiles(text), rawMarkdown: text.trim() };
}

/** Build (or revise) the artifact for a message: same plan id bumps revision. */
export function artifactFromDetection(
  detected: DetectedPlanBody,
  previous: PlanArtifact | null,
  now = new Date().toISOString(),
): PlanArtifact {
  const id = planIdFor(detected.title, detected.steps[0]?.title ?? "");
  if (previous && previous.id === id) {
    return {
      ...previous,
      revision: previous.revision + 1,
      title: detected.title,
      steps: detected.steps,
      scopeFiles: detected.scopeFiles,
      rawMarkdown: detected.rawMarkdown,
      status: "pending",
      // feedbackDraft survives in-place revisions (copilot CurrentPlan pattern).
      feedbackDraft: previous.feedbackDraft,
      originPosture: previous.originPosture ?? null,
    };
  }
  return {
    id,
    revision: 1,
    title: detected.title,
    steps: detected.steps,
    scopeFiles: detected.scopeFiles,
    rawMarkdown: detected.rawMarkdown,
    createdAt: now,
    status: "pending",
    // Transient state resets on a new plan id: no draft carry-over.
    feedbackDraft: undefined,
    originPosture: previous?.originPosture ?? null,
  };
}

/** Stable plan id from the title + first step (djb2 hex, `plan-` prefixed). */
export function planIdFor(title: string, firstStep: string): string {
  return `plan-${hashHex(`${title.trim().toLowerCase()}\n${firstStep.trim().toLowerCase()}`)}`;
}

/** Short content hash used to re-find a manually-marked plan's source message. */
export function messageHashFor(text: string): string {
  return hashHex(text.trim());
}

/**
 * Card teaser (copilot `teaserFromMarkdown` pattern): the heading plus the
 * first bullets, capped so the card stays a teaser and the full plan lives
 * behind "Open full plan".
 */
export function teaserLines(artifact: PlanArtifact, maxBullets = 3): string[] {
  const lines = artifact.rawMarkdown.split("\n").map((line) => line.trim());
  const out: string[] = [];
  for (const line of lines) {
    if (out.length >= maxBullets) break;
    if (!line) continue;
    if (/^#{1,6}\s+/.test(line)) continue;
    if (/^([-*+]|\d+[.)])\s+/.test(line)) out.push(line.replace(/^([-*+]|\d+[.)])\s+/, "").slice(0, 160));
  }
  if (out.length === 0) {
    for (const step of artifact.steps.slice(0, maxBullets)) out.push(step.title);
  }
  return out;
}

export interface PlanHandoffOptions {
  /** Include the fresh-thread prefix (long session, high context use). */
  freshThread?: boolean;
  /** Context fill percent at approve time, surfaced in the handoff note. */
  contextPercent?: number;
}

/**
 * Artifact-scoped implement handoff (title + steps + scope) — replaces the
 * fixed `"Implement the proposed plan above."` string so execution carries
 * the reviewed content, not a dangling reference.
 */
export function buildPlanHandoff(artifact: PlanArtifact, options: PlanHandoffOptions = {}): string {
  const lines: string[] = [];
  if (options.freshThread) {
    lines.push(
      "A previous agent produced the plan below. Treat it as the source of intent, re-read files as needed, then implement it.",
    );
    lines.push("");
  }
  lines.push(`Implement the following approved plan "${artifact.title}":`);
  lines.push("");
  artifact.steps.forEach((step, index) => {
    lines.push(`${index + 1}. ${step.title}${step.scope ? ` (${step.scope})` : ""}`);
  });
  if (artifact.scopeFiles.length > 0) {
    lines.push("");
    lines.push(`Scope: ${artifact.scopeFiles.join(", ")}`);
  }
  if (options.contextPercent !== undefined) {
    lines.push("");
    lines.push(`(Approved with vault context at ${options.contextPercent}%.)`);
  }
  return lines.join("\n");
}

/** Human summary for the approve gate: "~N steps · M files". */
export function planEffortSummary(artifact: PlanArtifact): string {
  const steps = `${artifact.steps.length} step${artifact.steps.length === 1 ? "" : "s"}`;
  const files = artifact.scopeFiles.length === 0 ? "no files listed" : `${artifact.scopeFiles.length} file${artifact.scopeFiles.length === 1 ? "" : "s"}`;
  return `${steps} · ${files}`;
}

function extractFencedPlanBlock(text: string): string | null {
  const match = /<plan>([\s\S]*?)<\/plan>/i.exec(text);
  return match?.[1] ? match[1] : null;
}

function hasPlanHeading(lines: string[]): boolean {
  return lines.some((line) => /^#{1,6}\s+.*(plan|proposal|steps|approach|todo)/i.test(line.trim()));
}

function extractPlanTitle(lines: string[]): string {
  for (const line of lines) {
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line.trim());
    if (heading?.[1]) return heading[1].trim().slice(0, 120);
  }
  for (const line of lines) {
    const bold = /^\*\*(.+?)\*\*\s*$/.exec(line.trim());
    if (bold?.[1]) return bold[1].trim().slice(0, 120);
  }
  const first = lines.find((line) => line.trim());
  return (first?.trim() ?? "Proposed plan").slice(0, 120);
}

function extractPlanSteps(lines: string[]): PlanStep[] {
  const steps: PlanStep[] = [];
  for (const line of lines) {
    const match = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/.exec(line);
    if (!match?.[1]) continue;
    const title = match[1].trim();
    if (!title) continue;
    const scope = backtickedPath(title);
    steps.push(scope ? { title, scope } : { title });
    if (steps.length >= 50) break;
  }
  return steps;
}

function countNumberedSteps(lines: string[]): number {
  return lines.filter((line) => /^\s*\d+[.)]\s+\S/.test(line)).length;
}

function backtickedPath(title: string): string | undefined {
  const match = /`([^`]+)`/.exec(title);
  return match?.[1]?.trim() || undefined;
}

/** Vault paths referenced in the plan: backticked segments + bare path tokens. */
function extractScopeFiles(body: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const push = (value: string) => {
    const trimmed = value.trim().replace(/^[[(]|[.,;:)\]]+$/g, "");
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    found.push(trimmed);
  };
  for (const match of body.matchAll(/`([^`]+)`/g)) {
    const candidate = match[1].trim();
    if (/[/\\]/.test(candidate) || /\.[a-z0-9]{1,5}$/i.test(candidate)) push(candidate);
  }
  for (const match of body.matchAll(/(?:^|\s)([\w~.-]+(?:\/[\w~.-]+)+\w)(?=\s|[.,;:)\]]|$)/g)) {
    push(match[1]);
  }
  return found.slice(0, 20);
}

function hashHex(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Per-session plan memory: the posture to restore when a session leaves plan
 * mode. Keyed by session (agent-client pattern: mode/session state belongs to
 * the session, not the app singleton) so background tabs never share it.
 */
export class PlanMemoryStore {
  private readonly previousBySession = new Map<string, import("./modes").AgentMode | null>();

  get(sessionKey: string): import("./modes").AgentMode | null {
    return this.previousBySession.get(sessionKey) ?? null;
  }

  set(sessionKey: string, previous: import("./modes").AgentMode | null): void {
    if (previous === null) this.previousBySession.delete(sessionKey);
    else this.previousBySession.set(sessionKey, previous);
  }

  clear(sessionKey: string): void {
    this.previousBySession.delete(sessionKey);
  }
}

/** Session key for plan state: stable across restarts (path), id fallback. */
export function planSessionKey(
  info: { id?: string; path?: string | null } | undefined,
  fallback: string,
): string {
  if (info?.path) return `path:${info.path}`;
  if (info?.id) return `id:${info.id}`;
  return fallback;
}

/** Heal a persisted plan artifact; null when the stored shape is unusable. */
export function healPlanArtifact(value: unknown): PlanArtifact | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : null;
  const title = typeof record.title === "string" && record.title.trim() ? record.title.trim() : null;
  const rawMarkdown = typeof record.rawMarkdown === "string" ? record.rawMarkdown : "";
  if (!id || !title || !rawMarkdown) return null;
  const steps = Array.isArray(record.steps)
    ? record.steps
        .filter((step): step is Record<string, unknown> => !!step && typeof step === "object" && !Array.isArray(step))
        .map((step) => ({
          title: typeof step.title === "string" ? step.title.slice(0, 300) : "",
          scope: typeof step.scope === "string" && step.scope.trim() ? step.scope.trim().slice(0, 200) : undefined,
        }))
        .filter((step) => step.title)
        .slice(0, 50)
    : [];
  const scopeFiles = Array.isArray(record.scopeFiles)
    ? record.scopeFiles.filter((file): file is string => typeof file === "string" && !!file.trim()).slice(0, 20)
    : [];
  const revision = typeof record.revision === "number" && Number.isFinite(record.revision) && record.revision >= 1
    ? Math.trunc(record.revision)
    : 1;
  const status = healPlanStatus(record.status);
  const createdAt = typeof record.createdAt === "string" && record.createdAt ? record.createdAt : new Date(0).toISOString();
  const feedbackDraft =
    typeof record.feedbackDraft === "string" && record.feedbackDraft.trim()
      ? record.feedbackDraft.slice(0, 2000)
      : undefined;
  const messageHash = typeof record.messageHash === "string" && record.messageHash ? record.messageHash : undefined;
  const originPosture = record.originPosture === "safe" || record.originPosture === "yolo" ? record.originPosture : null;
  return { id, revision, title, steps, scopeFiles, rawMarkdown, createdAt, status, feedbackDraft, messageHash, originPosture };
}

function healPlanStatus(value: unknown): PlanArtifactStatus {
  if (value === "approved" || value === "rejected" || value === "executing" || value === "implemented") return value;
  return "pending";
}
