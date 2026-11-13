import type { App, TFile } from "obsidian";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { IgnoreMatcher } from "../../vault/ignore";
import { normalizeVaultPath } from "../../vault/path";
import type { ReadMemo } from "../../vault/read-memo";
import { truncateToolOutput } from "../../vault/truncate";
import { toolResult, untrustedToolResult } from "../result";

export const TEXT_EXTENSIONS = new Set([
  "md", "txt", "json", "jsonl", "csv", "tsv", "yaml", "yml",
  "css", "js", "ts", "tsx", "jsx", "html", "xml",
]);

export interface VaultToolFactoryContext {
  app: App;
  isIgnored: IgnoreMatcher;
  memo?: ReadMemo;
}

export function normalizeVisibleVaultPath(isIgnored: IgnoreMatcher, path: string): string {
  const normalized = normalizeVaultPath(path);
  assertVisible(isIgnored, normalized);
  return normalized;
}

export function getVisibleVaultFile(app: App, isIgnored: IgnoreMatcher, path: string): { path: string; file: TFile } {
  const normalized = normalizeVisibleVaultPath(isIgnored, path);
  return { path: normalized, file: getVaultFile(app, normalized) };
}

export function getVaultFile(app: App, path: string): TFile {
  const file = app.vault.getFileByPath(path);
  if (!file) throw new Error(`File not found: ${path}`);
  return file;
}

/**
 * Reject access to an ignored path with the same error a missing file produces,
 * so the model cannot distinguish "hidden" from "does not exist".
 */
export function assertVisible(isIgnored: IgnoreMatcher, path: string): void {
  if (isIgnored(path)) throw new Error(`File not found: ${path}`);
}

/** Strip edge slashes from adapter entries (loader parity: trimEdges). */
export function trimSlashes(entry: string): string {
  let start = 0;
  let end = entry.length;
  while (start < end && entry[start] === "/") start += 1;
  while (end > start && entry[end - 1] === "/") end -= 1;
  return entry.slice(start, end);
}

export function textResult(text: string, details: Record<string, unknown>): AgentToolResult<Record<string, unknown>> {
  return toolResult(truncateToolOutput(text), details);
}

export function untrustedTextResult(
  text: string,
  details: Record<string, unknown>,
  toolName?: string,
): AgentToolResult<Record<string, unknown>> {
  return untrustedToolResult(text, details, toolName);
}
