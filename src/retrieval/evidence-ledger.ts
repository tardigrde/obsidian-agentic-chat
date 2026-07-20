import type {
  ToolArtifactMetadata,
  ToolArtifactStoreLike,
} from "../artifacts/tool-artifact-store";
import type { IgnoreMatcher } from "../vault/ignore";
import {
  formatSourceReference,
  parseSourceReference,
  sourceReferenceKey,
  type SourceReference,
} from "./citations";
import type { RetrievalDiagnosticsBundle } from "./diagnostics";

export const EVIDENCE_LEDGER_CONTENT_TYPE = "application/vnd.agentic-chat.evidence-ledger+json";
export const EVIDENCE_LEDGER_SOURCE_TOOL = "agentic-chat.evidence-ledger";

export type EvidenceLedgerVersion = 1;

export interface EvidenceLedgerMetadata {
  readonly [key: string]: string | number | boolean | null;
}

export interface EvidenceLedger {
  version: EvidenceLedgerVersion;
  sessionId?: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  sources: readonly EvidenceLedgerSource[];
  claims: readonly EvidenceLedgerClaim[];
  diagnostics: readonly EvidenceLedgerDiagnosticsEntry[];
  redactions: readonly EvidenceLedgerRedaction[];
}

export interface EvidenceLedgerSource {
  key: string;
  kind: SourceReference["type"];
  reference: SourceReference;
  citation: string;
  addedAt: string;
  label?: string;
  excerpt?: string;
  metadata?: EvidenceLedgerMetadata;
}

export interface EvidenceLedgerClaim {
  id: string;
  text: string;
  sourceKeys: readonly string[];
  createdAt: string;
}

export interface EvidenceLedgerDiagnosticsEntry {
  id: string;
  addedAt: string;
  bundle: RetrievalDiagnosticsBundle;
}

export interface EvidenceLedgerRedaction {
  id: string;
  reason: "ignored-path" | "invalid-source";
  sourceKind?: SourceReference["type"];
  createdAt: string;
}

export interface EvidenceLedgerCreateOptions {
  sessionId?: string;
  title?: string;
  now?: () => number;
}

export interface EvidenceSourceInput {
  reference: SourceReference | string;
  label?: string;
  excerpt?: string;
  metadata?: EvidenceLedgerMetadata;
}

export interface AddEvidenceSourceOptions {
  ignoreMatcher?: IgnoreMatcher;
  now?: () => number;
}

export interface AddEvidenceSourceResult {
  ledger: EvidenceLedger;
  sourceKey?: string;
  redacted: boolean;
}

export interface EvidenceClaimInput {
  id?: string;
  text: string;
  sourceKeys: readonly string[];
}

export interface AddEvidenceClaimOptions {
  now?: () => number;
}

export interface AddEvidenceDiagnosticsOptions {
  id?: string;
  now?: () => number;
}

export function createEvidenceLedger(options: EvidenceLedgerCreateOptions = {}): EvidenceLedger {
  const createdAt = timestamp(options.now);
  return {
    version: 1,
    sessionId: options.sessionId,
    title: options.title,
    createdAt,
    updatedAt: createdAt,
    sources: [],
    claims: [],
    diagnostics: [],
    redactions: [],
  };
}

export function addEvidenceSource(
  ledger: EvidenceLedger,
  input: EvidenceSourceInput,
  options: AddEvidenceSourceOptions = {},
): AddEvidenceSourceResult {
  const addedAt = timestamp(options.now);
  const reference = normalizeReference(input.reference);
  if (!reference) {
    return {
      ledger: appendRedaction(ledger, {
        id: nextId("redaction", ledger.redactions),
        reason: "invalid-source",
        createdAt: addedAt,
      }),
      redacted: true,
    };
  }

  if (isIgnoredReference(reference, options.ignoreMatcher)) {
    return {
      ledger: appendRedaction(ledger, {
        id: nextId("redaction", ledger.redactions),
        reason: "ignored-path",
        sourceKind: reference.type,
        createdAt: addedAt,
      }),
      redacted: true,
    };
  }

  const labeledReference = withSourceLabel(reference, input.label);
  const source: EvidenceLedgerSource = {
    key: sourceReferenceKey(labeledReference),
    kind: labeledReference.type,
    reference: labeledReference,
    citation: formatSourceReference(labeledReference),
    addedAt,
    label: input.label ?? labeledReference.label,
    excerpt: input.excerpt,
    metadata: input.metadata,
  };
  const existing = ledger.sources.some((candidate) => candidate.key === source.key);
  const sources = existing
    ? ledger.sources.map((candidate) => (candidate.key === source.key ? mergeSource(candidate, source) : candidate))
    : [...ledger.sources, source];

  return {
    ledger: { ...ledger, updatedAt: addedAt, sources },
    sourceKey: source.key,
    redacted: false,
  };
}

export function addEvidenceClaim(
  ledger: EvidenceLedger,
  input: EvidenceClaimInput,
  options: AddEvidenceClaimOptions = {},
): EvidenceLedger {
  const createdAt = timestamp(options.now);
  const knownSources = new Set(ledger.sources.map((source) => source.key));
  const sourceKeys = [...new Set(input.sourceKeys)];
  const missing = sourceKeys.filter((sourceKey) => !knownSources.has(sourceKey));
  if (missing.length > 0) {
    throw new Error(`Evidence claim references unknown sources: ${missing.join(", ")}`);
  }
  if (!input.text.trim()) throw new Error("Evidence claim text is required.");

  const claim: EvidenceLedgerClaim = {
    id: input.id ?? nextId("claim", ledger.claims),
    text: input.text.trim(),
    sourceKeys,
    createdAt,
  };
  return { ...ledger, updatedAt: createdAt, claims: [...ledger.claims, claim] };
}

export function addRetrievalDiagnostics(
  ledger: EvidenceLedger,
  bundle: RetrievalDiagnosticsBundle,
  options: AddEvidenceDiagnosticsOptions = {},
): EvidenceLedger {
  const addedAt = timestamp(options.now);
  const entry: EvidenceLedgerDiagnosticsEntry = {
    id: options.id ?? nextId("diagnostics", ledger.diagnostics),
    addedAt,
    bundle,
  };
  return { ...ledger, updatedAt: addedAt, diagnostics: [...ledger.diagnostics, entry] };
}

export function serializeEvidenceLedger(ledger: EvidenceLedger): string {
  return JSON.stringify(ledger, null, 2);
}

export function parseEvidenceLedger(text: string): EvidenceLedger {
  const parsed = JSON.parse(text) as Partial<EvidenceLedger>;
  if (parsed.version !== 1) throw new Error("Unsupported evidence ledger version.");
  if (!Array.isArray(parsed.sources)) throw new Error("Evidence ledger sources must be an array.");
  if (!Array.isArray(parsed.claims)) throw new Error("Evidence ledger claims must be an array.");
  if (!Array.isArray(parsed.diagnostics)) throw new Error("Evidence ledger diagnostics must be an array.");
  if (!Array.isArray(parsed.redactions)) throw new Error("Evidence ledger redactions must be an array.");
  return parsed as EvidenceLedger;
}

export async function writeEvidenceLedgerArtifact(
  store: ToolArtifactStoreLike,
  ledger: EvidenceLedger,
): Promise<ToolArtifactMetadata> {
  return store.writeArtifact({
    label: ledger.title ? `Evidence ledger: ${ledger.title}` : "Evidence ledger",
    sourceToolName: EVIDENCE_LEDGER_SOURCE_TOOL,
    text: serializeEvidenceLedger(ledger),
    contentType: EVIDENCE_LEDGER_CONTENT_TYPE,
  });
}

export async function readEvidenceLedgerArtifact(
  store: ToolArtifactStoreLike,
  artifactId: string,
): Promise<EvidenceLedger> {
  const artifact = await store.readArtifact(artifactId);
  return parseEvidenceLedger(artifact.text);
}

function appendRedaction(ledger: EvidenceLedger, redaction: EvidenceLedgerRedaction): EvidenceLedger {
  return {
    ...ledger,
    updatedAt: redaction.createdAt,
    redactions: [...ledger.redactions, redaction],
  };
}

function normalizeReference(reference: SourceReference | string): SourceReference | null {
  return typeof reference === "string" ? parseSourceReference(reference) : reference;
}

function isIgnoredReference(reference: SourceReference, ignoreMatcher: IgnoreMatcher | undefined): boolean {
  return reference.type === "note" && reference.path !== undefined && ignoreMatcher?.(reference.path) === true;
}

function withSourceLabel(reference: SourceReference, label: string | undefined): SourceReference {
  const normalized = label?.trim();
  return normalized ? { ...reference, label: normalized } : reference;
}

function mergeSource(current: EvidenceLedgerSource, next: EvidenceLedgerSource): EvidenceLedgerSource {
  return {
    ...current,
    label: current.label ?? next.label,
    excerpt: current.excerpt ?? next.excerpt,
    metadata: mergeMetadata(current.metadata, next.metadata),
  };
}

function mergeMetadata(
  current: EvidenceLedgerMetadata | undefined,
  next: EvidenceLedgerMetadata | undefined,
): EvidenceLedgerMetadata | undefined {
  if (!current) return next;
  if (!next) return current;
  return { ...next, ...current };
}

function nextId(prefix: string, collection: readonly unknown[]): string {
  return `${prefix}-${collection.length + 1}`;
}

function timestamp(now: (() => number) | undefined): string {
  return new Date(now?.() ?? Date.now()).toISOString();
}
