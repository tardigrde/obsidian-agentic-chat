import type { DataAdapter } from "obsidian";
import {
  formatSourceReference,
  parseSourceReference,
} from "../retrieval/citations";
import { loadMemoryRecords, type MemoryProvenanceEntry, type MemoryRecord } from "./memory";

export interface MemoryConsolidation {
  keptId: string;
  mergedIds: readonly string[];
}

export interface MemoryConsolidationResult {
  records: MemoryRecord[];
  consolidations: readonly MemoryConsolidation[];
}

export interface StaleMemoryAgingResult {
  records: MemoryRecord[];
  agedIds: readonly string[];
}

export interface ForgetMemoryResult {
  records: MemoryRecord[];
  forgotten?: MemoryRecord;
}

export interface DeleteMemoryResult {
  records: MemoryRecord[];
  deleted?: MemoryRecord;
}

export interface MemoryExport {
  records: MemoryRecord[];
  jsonl: string;
}

export function consolidateDuplicateMemories(records: readonly MemoryRecord[]): MemoryConsolidationResult {
  const groups = new Map<string, MemoryRecord[]>();
  for (const record of records) {
    const key = consolidationKey(record);
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }

  const output: MemoryRecord[] = [];
  const consolidations: MemoryConsolidation[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      output.push(group[0]);
      continue;
    }
    const kept = newestRecord(group);
    const duplicates = group.filter((record) => record.id !== kept.id);
    output.push(mergeMemoryGroup(kept, duplicates));
    consolidations.push({ keptId: kept.id, mergedIds: duplicates.map((record) => record.id) });
  }

  return { records: output.sort(compareMemoryIds), consolidations };
}

export function ageStaleMemories(
  records: readonly MemoryRecord[],
  options: { now: number; staleAfterDays: number },
): StaleMemoryAgingResult {
  const agedIds: string[] = [];
  const thresholdMs = options.staleAfterDays * 24 * 60 * 60 * 1000;
  const updated = records.map((record) => {
    if (record.enabled === false || record.stale) return record;
    const timestamp = Date.parse(record.updatedAt ?? record.createdAt ?? "");
    if (!Number.isFinite(timestamp) || options.now - timestamp < thresholdMs) return record;
    agedIds.push(record.id);
    return {
      ...record,
      stale: true,
      updatedAt: new Date(options.now).toISOString(),
      confidence: Math.min(record.confidence ?? 0.5, 0.4),
      tags: uniqueStrings([...(record.tags ?? []), "stale"]),
    };
  });
  return { records: updated, agedIds };
}

export function forgetMemory(
  records: readonly MemoryRecord[],
  id: string,
  options: { now: number; reason?: string },
): ForgetMemoryResult {
  let forgotten: MemoryRecord | undefined;
  const updated = records.map((record) => {
    if (record.id !== id) return record;
    forgotten = {
      ...record,
      enabled: false,
      forgottenAt: new Date(options.now).toISOString(),
      forgetReason: options.reason?.trim() || undefined,
      updatedAt: new Date(options.now).toISOString(),
    };
    return forgotten;
  });
  return { records: updated, forgotten };
}

export function deleteMemory(records: readonly MemoryRecord[], id: string): DeleteMemoryResult {
  const deleted = records.find((record) => record.id === id);
  return {
    records: records.filter((record) => record.id !== id),
    deleted,
  };
}

export function migrateMemoryRecords(records: readonly MemoryRecord[], options: { now: number }): MemoryRecord[] {
  return records.map((record) => {
    const provenance = record.provenance?.length
      ? record.provenance
      : record.source
        ? [{ source: record.source, extractedAt: record.createdAt ?? new Date(options.now).toISOString() }]
        : undefined;
    return {
      ...record,
      enabled: record.enabled ?? true,
      provenance,
    };
  });
}

export function explainMemoryProvenance(record: MemoryRecord): string {
  const lines = [`Memory ${record.id}`, `${record.kind} (${record.scope})`, record.text];
  if (record.source) lines.push(`Source: ${formatSource(record.source)}`);
  for (const entry of record.provenance ?? []) {
    lines.push(`Provenance: ${formatSource(entry.source)}${entry.extractedAt ? ` at ${entry.extractedAt}` : ""}`);
    if (entry.note) lines.push(`Note: ${entry.note}`);
  }
  if (record.supersedes?.length) lines.push(`Supersedes: ${record.supersedes.join(", ")}`);
  if (record.stale) lines.push("Status: stale");
  if (record.enabled === false) {
    lines.push(`Status: forgotten${record.forgottenAt ? ` at ${record.forgottenAt}` : ""}`);
    if (record.forgetReason) lines.push(`Reason: ${record.forgetReason}`);
  }
  if (record.confidence !== undefined) lines.push(`Confidence: ${record.confidence}`);
  return lines.join("\n");
}

export async function writeMemoryRecords(
  adapter: DataAdapter,
  path: string,
  records: readonly MemoryRecord[],
): Promise<void> {
  await ensureParentDirs(adapter, path);
  await adapter.write(path, memoryRecordsToJsonl(records));
}

export function memoryRecordsToJsonl(records: readonly MemoryRecord[]): string {
  return records.length ? `${records.map((record) => JSON.stringify(record)).join("\n")}\n` : "";
}

export async function exportMemoryRecords(adapter: DataAdapter, path: string): Promise<MemoryExport> {
  const records = await loadMemoryRecords(adapter, path);
  return { records, jsonl: memoryRecordsToJsonl(records) };
}

export async function clearMemoryRecords(adapter: DataAdapter, path: string): Promise<number> {
  const records = await loadMemoryRecords(adapter, path);
  if (await adapter.exists(path)) await adapter.remove(path);
  return records.length;
}

function mergeMemoryGroup(kept: MemoryRecord, duplicates: readonly MemoryRecord[]): MemoryRecord {
  const provenance = mergeProvenance(kept, duplicates);
  return {
    ...kept,
    source: kept.source ?? duplicates.find((record) => record.source)?.source,
    tags: uniqueStrings([...(kept.tags ?? []), ...duplicates.flatMap((record) => record.tags ?? []), "consolidated"]),
    provenance,
    supersedes: uniqueStrings([...(kept.supersedes ?? []), ...duplicates.map((record) => record.id)]),
    confidence: Math.max(kept.confidence ?? 0, ...duplicates.map((record) => record.confidence ?? 0)) || undefined,
  };
}

function mergeProvenance(kept: MemoryRecord, duplicates: readonly MemoryRecord[]): readonly MemoryProvenanceEntry[] | undefined {
  const entries = [kept, ...duplicates].flatMap((record) => {
    const provenance = record.provenance ?? [];
    const sourceEntry: MemoryProvenanceEntry[] = record.source
      ? [{ source: record.source, extractedAt: record.createdAt }]
      : [];
    return [...provenance, ...sourceEntry];
  });
  const seen = new Set<string>();
  const unique = entries.filter((entry) => {
    const key = `${entry.source}\n${entry.extractedAt ?? ""}\n${entry.note ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique.length ? unique : undefined;
}

function newestRecord(records: readonly MemoryRecord[]): MemoryRecord {
  return [...records].sort((left, right) => recordTime(right) - recordTime(left) || left.id.localeCompare(right.id))[0];
}

function recordTime(record: MemoryRecord): number {
  const parsed = Date.parse(record.updatedAt ?? record.createdAt ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function consolidationKey(record: MemoryRecord): string {
  return `${record.kind}:${record.scope}:${record.text.toLowerCase().replace(/\s+/g, " ").trim()}`;
}

function compareMemoryIds(left: MemoryRecord, right: MemoryRecord): number {
  return left.id.localeCompare(right.id);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()).map((value) => value.trim()))];
}

function formatSource(source: string): string {
  const parsed = parseSourceReference(source);
  return parsed ? formatSourceReference(parsed) : source;
}

async function ensureParentDirs(adapter: DataAdapter, path: string): Promise<void> {
  const parts = path.split("/").slice(0, -1);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!(await adapter.exists(current))) await adapter.mkdir(current);
  }
}
