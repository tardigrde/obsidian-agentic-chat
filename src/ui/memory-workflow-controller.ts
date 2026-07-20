import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { DataAdapter } from "obsidian";
import {
  approveAndAppendMemoryProposal,
  extractMemoryProposals,
  type MemoryExtractionProposal,
} from "../memory/extraction";
import {
  clearMemoryRecords,
  consolidateDuplicateMemories,
  explainMemoryProvenance,
  exportMemoryRecords,
  forgetMemory,
  writeMemoryRecords,
} from "../memory/management";
import { loadMemoryRecords, type MemoryKind, type MemoryRecord, type MemoryScope } from "../memory/memory";
import { containsSensitiveText } from "../privacy/redaction";
import type { WorkflowRenderer } from "./workflow-renderer";

export interface MemoryWorkflowControllerOptions {
  adapter: DataAdapter;
  memoryPath: () => string;
  messages: () => readonly AgentMessage[];
  defaultScope: () => MemoryScope;
  sessionSource: () => string | undefined;
  renderer: WorkflowRenderer;
  writeExport: (filename: string, contents: string) => Promise<string>;
  now?: () => number;
}

export class MemoryWorkflowController {
  constructor(private readonly options: MemoryWorkflowControllerOptions) {}

  async run(arg: string): Promise<void> {
    this.options.renderer.clear();
    const [subcommand, ...rest] = arg.trim().split(/\s+/).filter(Boolean);
    if (subcommand === "add" || subcommand === "remember") {
      await this.addManual(rest.join(" "));
      return;
    }
    if (subcommand === "manage") {
      await this.showManager();
      return;
    }
    if (subcommand === "consolidate") {
      await this.consolidate();
      return;
    }
    if (subcommand === "provenance") {
      await this.showProvenance(rest[0]);
      return;
    }
    if (subcommand === "export") {
      await this.export();
      return;
    }
    if (subcommand === "clear") {
      await this.clear(rest.includes("--confirm"));
      return;
    }
    if (subcommand && subcommand !== "review") {
      this.options.renderer.error(`Unknown memory command "${subcommand}". Try /memory add <text>.`);
      return;
    }
    await this.review();
  }

  async approveProposal(proposal: MemoryExtractionProposal): Promise<void> {
    const decision = await approveAndAppendMemoryProposal(this.options.adapter, this.path(), proposal, {
      now: this.now(),
    });
    if (decision.status === "duplicate") {
      this.options.renderer.info("Memory", [[proposal.text, `Already saved as ${decision.duplicateOf}.`]]);
      return;
    }
    if (decision.status === "approved") {
      this.options.renderer.info("Memory", [[decision.record.id, "Saved."]]);
    }
  }

  async forget(id: string): Promise<void> {
    const records = await loadMemoryRecords(this.options.adapter, this.path());
    const result = forgetMemory(records, id, { now: this.now(), reason: "Forgotten from chat UI" });
    if (!result.forgotten) {
      this.options.renderer.info("Memory", [[id, "Not found."]]);
      return;
    }
    await writeMemoryRecords(this.options.adapter, this.path(), result.records);
    this.options.renderer.info("Memory", [[id, "Forgotten."]]);
  }

  private async review(): Promise<void> {
    const existing = await loadMemoryRecords(this.options.adapter, this.path());
    const proposals = extractMemoryProposals(this.options.messages(), {
      existingRecords: existing,
      defaultScope: this.options.defaultScope(),
      source: this.options.sessionSource(),
    });
    if (proposals.length === 0) {
      this.options.renderer.info("Memory", [["(none)", "No durable memory proposals found in this conversation."]]);
      return;
    }
    this.options.renderer.actionList(
      "Memory proposals",
      "Click a proposal to save it. Ignoring this list rejects it for now.",
      proposals.map((proposal) => ({
        label: proposal.text,
        detail: this.proposalDetail(proposal),
        icon: proposal.kind === "preference" ? "sliders-horizontal" : "database",
        onClick: () => void this.approveProposal(proposal),
      })),
    );
  }

  private async addManual(raw: string): Promise<void> {
    const parsed = parseManualMemorySpec(raw, this.options.defaultScope());
    if (!parsed.text) {
      this.options.renderer.error("Usage: /memory add [preference|fact|instruction|summary] [global|vault|project] <text>");
      return;
    }
    if (containsSensitiveText(parsed.text)) {
      this.options.renderer.error("Memory text looks like it may contain a secret. Not saved.");
      return;
    }

    const records = await loadMemoryRecords(this.options.adapter, this.path());
    const duplicate = records.find(
      (record) =>
        record.enabled !== false &&
        record.kind === parsed.kind &&
        record.scope === parsed.scope &&
        normalizeManualMemoryText(record.text) === normalizeManualMemoryText(parsed.text),
    );
    if (duplicate) {
      this.options.renderer.info("Memory", [[parsed.text, `Already saved as ${duplicate.id}.`]]);
      return;
    }

    const timestamp = new Date(this.now()).toISOString();
    const source = this.options.sessionSource();
    const record: MemoryRecord = {
      id: manualMemoryId(parsed.kind, parsed.scope, parsed.text),
      kind: parsed.kind,
      text: sentence(parsed.text),
      scope: parsed.scope,
      source,
      provenance: source ? [{ source, extractedAt: timestamp, note: "Manual /memory add" }] : undefined,
      tags: ["manual"],
      enabled: true,
      createdAt: timestamp,
      updatedAt: timestamp,
      confidence: 1,
    };
    await writeMemoryRecords(this.options.adapter, this.path(), [
      ...records.filter((candidate) => candidate.id !== record.id),
      record,
    ]);
    this.options.renderer.info("Memory", [[record.id, "Saved."]]);
  }

  private async showManager(): Promise<void> {
    const records = await loadMemoryRecords(this.options.adapter, this.path());
    const visible = records.filter((record) => record.enabled !== false);
    if (visible.length === 0) {
      this.options.renderer.info("Memory", [["(none)", "No enabled memories to manage."]]);
      return;
    }
    this.options.renderer.actionList(
      "Memory",
      "Click a memory to forget it. Use /memory provenance <id> for source details.",
      visible.map((record) => ({
        label: record.text,
        detail: `${record.id} · ${record.kind} · ${record.scope}`,
        icon: record.kind === "preference" ? "sliders-horizontal" : "database",
        onClick: () => void this.forget(record.id),
      })),
    );
  }

  private async export(): Promise<void> {
    const exported = await exportMemoryRecords(this.options.adapter, this.path());
    if (exported.records.length === 0) {
      this.options.renderer.info("Memory", [["Export", "No stored memories to export."]]);
      return;
    }
    const filename = `Agentic chat memories ${this.exportStamp()}.jsonl`;
    const path = await this.options.writeExport(filename, exported.jsonl);
    this.options.renderer.info("Memory", [["Exported", `${exported.records.length} memories to ${path}.`]]);
  }

  private async clear(confirmed: boolean): Promise<void> {
    if (!confirmed) {
      this.options.renderer.error("This deletes stored long-term memories. Re-run with /memory clear --confirm.");
      return;
    }
    const deleted = await clearMemoryRecords(this.options.adapter, this.path());
    this.options.renderer.info("Memory", [["Deleted", `${deleted} memor${deleted === 1 ? "y" : "ies"}.`]]);
  }

  private async consolidate(): Promise<void> {
    const records = await loadMemoryRecords(this.options.adapter, this.path());
    const result = consolidateDuplicateMemories(records);
    await writeMemoryRecords(this.options.adapter, this.path(), result.records);
    this.options.renderer.info("Memory", [
      ["Consolidated", `${result.consolidations.length} duplicate ${result.consolidations.length === 1 ? "group" : "groups"}.`],
    ]);
  }

  private async showProvenance(id: string | undefined): Promise<void> {
    if (!id) {
      this.options.renderer.error("Usage: /memory provenance <memory-id>");
      return;
    }
    const records = await loadMemoryRecords(this.options.adapter, this.path());
    const record = records.find((candidate) => candidate.id === id);
    if (!record) {
      this.options.renderer.info("Memory", [[id, "Not found."]]);
      return;
    }
    this.options.renderer.info("Memory provenance", [[record.id, explainMemoryProvenance(record)]]);
  }

  private proposalDetail(proposal: MemoryExtractionProposal): string {
    const parts = [proposal.kind, proposal.scope, proposal.source ? `source: ${proposal.source}` : ""];
    if (proposal.duplicateOf) parts.push(`duplicate: ${proposal.duplicateOf}`);
    return parts.filter(Boolean).join(" · ");
  }

  private exportStamp(): string {
    return new Date(this.now()).toISOString().slice(0, 19).replace("T", " ").replaceAll(":", "-");
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private path(): string {
    return this.options.memoryPath();
  }
}

const MEMORY_KINDS = new Set<MemoryKind>(["preference", "fact", "instruction", "summary"]);
const MEMORY_SCOPES = new Set<MemoryScope>(["global", "vault", "project"]);

function parseManualMemorySpec(raw: string, defaultScope: MemoryScope): { kind: MemoryKind; scope: MemoryScope; text: string } {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  let kind: MemoryKind = "fact";
  let scope = defaultScope;
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index].toLowerCase();
    if (MEMORY_KINDS.has(token as MemoryKind)) {
      kind = token as MemoryKind;
      index += 1;
      continue;
    }
    if (MEMORY_SCOPES.has(token as MemoryScope)) {
      scope = token as MemoryScope;
      index += 1;
      continue;
    }
    break;
  }
  return { kind, scope, text: tokens.slice(index).join(" ").trim() };
}

function manualMemoryId(kind: MemoryKind, scope: MemoryScope, text: string): string {
  return `mem-${kind}-${scope}-${hashString(normalizeManualMemoryText(text))}`;
}

function normalizeManualMemoryText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "");
}

function sentence(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.codePointAt(index) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
