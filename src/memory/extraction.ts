import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { DataAdapter } from "obsidian";
import {
  formatSourceReference,
  parseSourceReference,
  type SourceReference,
} from "../retrieval/citations";
import {
  loadMemoryRecords,
  type MemoryKind,
  type MemoryRecord,
  type MemoryScope,
} from "./memory";
import { containsSensitiveText } from "../privacy/redaction";

export interface MemoryExtractionProposal {
  id: string;
  kind: Extract<MemoryKind, "preference" | "fact">;
  text: string;
  scope: MemoryScope;
  source?: string;
  reason: string;
  duplicateOf?: string;
}

export interface MemoryExtractionOptions {
  existingRecords?: readonly MemoryRecord[];
  defaultScope?: MemoryScope;
  source?: string | SourceReference;
  now?: number;
}

export type MemoryProposalDecision =
  | { status: "approved"; proposalId: string; record: MemoryRecord }
  | { status: "duplicate"; proposalId: string; duplicateOf: string; record: MemoryRecord }
  | { status: "rejected"; proposalId: string; reason?: string };

export interface MemoryApprovalOptions {
  now?: number;
}

const MAX_CAPTURE_LENGTH = 260;

export function extractMemoryProposals(
  messages: readonly AgentMessage[],
  options: MemoryExtractionOptions = {},
): MemoryExtractionProposal[] {
  const proposals: MemoryExtractionProposal[] = [];
  const seen = new Set<string>();
  const existing = new Map((options.existingRecords ?? []).map((record) => [memoryKey(record), record]));
  const scope = options.defaultScope ?? "vault";
  const fallbackSource = formatOptionalSource(options.source);

  messages.forEach((message, index) => {
    if (message.role !== "user" && message.role !== "assistant") return;
    const text = messageText(message);
    if (!text.trim()) return;
    const source = firstSourceReference(text) ?? fallbackSource;
    for (const candidate of candidatesFromText(text)) {
      if (containsSecretLikeText(candidate.text)) continue;
      const key = proposalKey(candidate.kind, candidate.text, scope);
      if (seen.has(key)) continue;
      seen.add(key);
      const duplicate = existing.get(key);
      proposals.push({
        id: stableProposalId(candidate.kind, candidate.text, scope),
        kind: candidate.kind,
        text: candidate.text,
        scope,
        source,
        reason: `${candidate.reason} in ${message.role} message ${index + 1}`,
        duplicateOf: duplicate?.id,
      });
    }
  });

  return proposals;
}

export function approveMemoryProposal(
  proposal: MemoryExtractionProposal,
  existingRecords: readonly MemoryRecord[],
  options: MemoryApprovalOptions = {},
): MemoryProposalDecision {
  const duplicate = existingRecords.find((record) => memoryKey(record) === proposalKey(proposal.kind, proposal.text, proposal.scope));
  if (duplicate) {
    return { status: "duplicate", proposalId: proposal.id, duplicateOf: duplicate.id, record: duplicate };
  }
  const timestamp = new Date(options.now ?? Date.now()).toISOString();
  return {
    status: "approved",
    proposalId: proposal.id,
    record: {
      id: proposal.id.replace(/^proposal-/, "mem-"),
      kind: proposal.kind,
      text: proposal.text,
      scope: proposal.scope,
      source: proposal.source,
      tags: ["extracted"],
      enabled: true,
      createdAt: timestamp,
      updatedAt: timestamp,
      confidence: 0.6,
    },
  };
}

export function rejectMemoryProposal(proposal: MemoryExtractionProposal, reason?: string): MemoryProposalDecision {
  return {
    status: "rejected",
    proposalId: proposal.id,
    reason: reason?.trim() || undefined,
  };
}

export async function appendApprovedMemoryRecord(
  adapter: DataAdapter,
  path: string,
  record: MemoryRecord,
): Promise<void> {
  await ensureParentDirs(adapter, path);
  const line = `${JSON.stringify(record)}\n`;
  if (await adapter.exists(path)) {
    await adapter.append(path, line);
  } else {
    await adapter.write(path, line);
  }
}

export async function approveAndAppendMemoryProposal(
  adapter: DataAdapter,
  path: string,
  proposal: MemoryExtractionProposal,
  options: MemoryApprovalOptions = {},
): Promise<MemoryProposalDecision> {
  const existing = await loadMemoryRecords(adapter, path);
  const decision = approveMemoryProposal(proposal, existing, options);
  if (decision.status === "approved") await appendApprovedMemoryRecord(adapter, path, decision.record);
  return decision;
}

function candidatesFromText(text: string): Array<{ kind: "preference" | "fact"; text: string; reason: string }> {
  const candidates: Array<{ kind: "preference" | "fact"; text: string; reason: string }> = [];
  collectMatches(text, /\b(?:i|we)\s+prefer\s+([^.!?\n]{4,260})/gi, (capture) => {
    candidates.push({
      kind: "preference",
      text: sentence(`The user prefers ${capture}`),
      reason: "preference phrase",
    });
  });
  collectMatches(text, /\bplease\s+always\s+([^.!?\n]{4,260})/gi, (capture) => {
    candidates.push({
      kind: "preference",
      text: sentence(`The user wants the assistant to always ${capture}`),
      reason: "standing instruction phrase",
    });
  });
  collectMatches(text, /\bremember that\s+([^.!?\n]{4,260})/gi, (capture) => {
    candidates.push({
      kind: capture.toLowerCase().startsWith("i prefer ") ? "preference" : "fact",
      text: sentence(capture),
      reason: "explicit remember phrase",
    });
  });
  collectMatches(text, /\b(?:my|our)\s+([A-Za-z][\w -]{2,40})\s+is\s+([^.!?\n]{2,160})/gi, (capture, match) => {
    const label = match[1]?.trim().toLowerCase();
    const value = match[2]?.trim();
    if (!label || !value) return;
    candidates.push({
      kind: "fact",
      text: sentence(`The user's ${label} is ${value}`),
      reason: "user fact phrase",
    });
  });
  return candidates;
}

function collectMatches(
  text: string,
  pattern: RegExp,
  onMatch: (capture: string, match: RegExpExecArray) => void,
): void {
  for (const match of text.matchAll(pattern)) {
    const capture = cleanCapture(match[1] ?? "");
    if (capture.length < 4 || capture.length > MAX_CAPTURE_LENGTH) continue;
    onMatch(capture, match as RegExpExecArray);
  }
}

function cleanCapture(value: string): string {
  return value
    .replace(/\[\[[^\]]+]]/g, "")
    .replace(/\[[^\]]+]\([^)]+\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sentence(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const cased = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(cased) ? cased : `${cased}.`;
}

function containsSecretLikeText(value: string): boolean {
  return containsSensitiveText(value);
}

function firstSourceReference(text: string): string | undefined {
  const candidates = [
    ...Array.from(text.matchAll(/\[\[[^\]]+]]/g), (match) => match[0]),
    ...Array.from(text.matchAll(/\[[^\]]+]\([^)]+\)/g), (match) => match[0]),
    ...Array.from(text.matchAll(/https?:\/\/\S+/g), (match) => match[0].replace(/[),.;]+$/, "")),
  ];
  for (const candidate of candidates) {
    const parsed = parseSourceReference(candidate);
    if (parsed) return formatSourceReference(parsed);
  }
  return undefined;
}

function formatOptionalSource(source: string | SourceReference | undefined): string | undefined {
  if (!source) return undefined;
  if (typeof source !== "string") return formatSourceReference(source);
  const parsed = parseSourceReference(source);
  return parsed ? formatSourceReference(parsed) : undefined;
}

function messageText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text",
    )
    .map((part) => part.text)
    .join("\n");
}

function memoryKey(record: Pick<MemoryRecord, "kind" | "text" | "scope">): string {
  return proposalKey(record.kind, record.text, record.scope);
}

function proposalKey(kind: MemoryKind, text: string, scope: MemoryScope): string {
  return `${kind}:${scope}:${normalizeText(text)}`;
}

function stableProposalId(kind: MemoryKind, text: string, scope: MemoryScope): string {
  return `proposal-${kind}-${scope}-${hashString(normalizeText(text))}`;
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

async function ensureParentDirs(adapter: DataAdapter, path: string): Promise<void> {
  const parts = path.split("/").slice(0, -1);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!(await adapter.exists(current))) await adapter.mkdir(current);
  }
}
