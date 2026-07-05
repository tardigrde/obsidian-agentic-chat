import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  appendApprovedMemoryRecord,
  approveAndAppendMemoryProposal,
  approveMemoryProposal,
  extractMemoryProposals,
  rejectMemoryProposal,
} from "../src/memory/extraction";
import { loadMemoryRecords, type MemoryRecord } from "../src/memory/memory";
import { MemoryAdapter } from "./helpers/memory-adapter";

const MEMORY_PATH = ".obsidian/plugins/agentic-chat/memory/memories.jsonl";
const NOW = Date.UTC(2026, 5, 26, 12, 0, 0);

function user(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: NOW } as AgentMessage;
}

function assistant(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    provider: "openrouter",
    model: "test/model",
    timestamp: NOW,
  } as AgentMessage;
}

describe("memory extraction proposals", () => {
  it("extracts durable preference and fact proposals with source links", () => {
    const proposals = extractMemoryProposals(
      [
        user(
          "I prefer concise answers with citations. Remember that the vault uses Hungarian notes. " +
            "See [[Notes/Preferences.md#Style|style source]].",
        ),
      ],
      { source: "[[Sessions/Today.md#Turn 1|chat turn]]" },
    );

    expect(proposals).toEqual([
      expect.objectContaining({
        kind: "preference",
        text: "The user prefers concise answers with citations.",
        scope: "vault",
        source: "[[Notes/Preferences.md#Style|style source]]",
      }),
      expect.objectContaining({
        kind: "fact",
        text: "The vault uses Hungarian notes.",
        source: "[[Notes/Preferences.md#Style|style source]]",
      }),
    ]);
  });

  it("approves and persists a proposal only after explicit approval", async () => {
    const adapter = new MemoryAdapter();
    const [proposal] = extractMemoryProposals([user("Please always include exact source citations.")], {
      source: "[[Sessions/Today.md#Turn 2|chat turn]]",
    });
    if (!proposal) throw new Error("Expected memory proposal.");

    await expect(loadMemoryRecords(adapter.asDataAdapter(), MEMORY_PATH)).resolves.toEqual([]);

    const decision = approveMemoryProposal(proposal, [], { now: NOW });
    expect(decision.status).toBe("approved");
    if (decision.status !== "approved") throw new Error("Expected approved decision.");
    await appendApprovedMemoryRecord(adapter.asDataAdapter(), MEMORY_PATH, decision.record);

    await expect(loadMemoryRecords(adapter.asDataAdapter(), MEMORY_PATH)).resolves.toEqual([
      expect.objectContaining({
        kind: "preference",
        text: "The user wants the assistant to always include exact source citations.",
        source: "[[Sessions/Today.md#Turn 2|chat turn]]",
        tags: ["extracted"],
        createdAt: new Date(NOW).toISOString(),
      }),
    ]);
  });

  it("records rejection without creating a durable memory", () => {
    const [proposal] = extractMemoryProposals([user("Remember that my preferred language is Hungarian.")]);
    if (!proposal) throw new Error("Expected memory proposal.");

    expect(rejectMemoryProposal(proposal, "too transient")).toEqual({
      status: "rejected",
      proposalId: proposal.id,
      reason: "too transient",
    });
  });

  it("marks duplicate proposals and does not append duplicate records", async () => {
    const existing: MemoryRecord = {
      id: "mem-existing",
      kind: "preference",
      scope: "vault",
      text: "The user prefers concise answers.",
    };
    const adapter = new MemoryAdapter();
    await adapter.write(MEMORY_PATH, `${JSON.stringify(existing)}\n`);
    const [proposal] = extractMemoryProposals([user("I prefer concise answers.")], {
      existingRecords: [existing],
    });
    if (!proposal) throw new Error("Expected duplicate proposal.");

    expect(proposal.duplicateOf).toBe("mem-existing");
    await expect(approveAndAppendMemoryProposal(adapter.asDataAdapter(), MEMORY_PATH, proposal, { now: NOW }))
      .resolves.toEqual({
        status: "duplicate",
        proposalId: proposal.id,
        duplicateOf: "mem-existing",
        record: existing,
      });
    await expect(loadMemoryRecords(adapter.asDataAdapter(), MEMORY_PATH)).resolves.toEqual([existing]);
  });

  it("skips secret-like content instead of proposing private credentials", () => {
    const proposals = extractMemoryProposals([
      user("Remember that my API key is sk-1234567890abcdef. I prefer short summaries."),
    ]);

    expect(proposals.map((proposal) => proposal.text)).toEqual(["The user prefers short summaries."]);
  });

  it("uses deterministic no-live-model fixtures", () => {
    const transcript = [
      user("Remember that the research vault is multilingual."),
      assistant("Noted. I will keep retrieval language in mind."),
      user("I prefer answers in English unless I ask otherwise."),
    ];

    const first = extractMemoryProposals(transcript, { defaultScope: "project", now: NOW });
    const second = extractMemoryProposals(transcript, { defaultScope: "project", now: NOW });

    expect(second).toEqual(first);
    expect(first.map((proposal) => [proposal.kind, proposal.scope, proposal.text])).toEqual([
      ["fact", "project", "The research vault is multilingual."],
      ["preference", "project", "The user prefers answers in English unless I ask otherwise."],
    ]);
  });
});
