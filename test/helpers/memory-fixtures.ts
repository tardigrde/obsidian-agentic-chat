import type { MemoryRecord } from "../../src/memory/memory";

export const FAKE_MEMORY_FIXTURE: readonly MemoryRecord[] = [
  {
    id: "mem-pref-concise",
    kind: "preference",
    scope: "global",
    text: "The user prefers concise answers with exact source citations.",
    source: "[[Notes/Preferences.md#Style|Style preference]]",
    tags: ["style", "citations"],
    confidence: 0.9,
  },
  {
    id: "mem-fact-embeddings",
    kind: "fact",
    scope: "vault",
    text: "Large vault embedding generation can be expensive without GPU acceleration.",
    source: "[Embedding note](https://example.com/embedding-costs)",
    tags: ["embeddings", "cost"],
    confidence: 0.8,
  },
  {
    id: "mem-project-secret",
    kind: "fact",
    scope: "project",
    text: "Project-only memory should not appear without project scope.",
    tags: ["project"],
  },
  {
    id: "mem-disabled",
    kind: "preference",
    scope: "global",
    text: "Disabled memory should not be returned.",
    enabled: false,
    tags: ["disabled"],
  },
];

export function fakeMemoryJsonl(records: readonly MemoryRecord[] = FAKE_MEMORY_FIXTURE): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}
