import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { MemoryWorkflowController } from "../src/ui/memory-workflow-controller";
import type { ActionRow, WorkflowRenderer } from "../src/ui/workflow-renderer";
import { loadMemoryRecords, parseMemoryRecords, type MemoryRecord, type MemoryScope } from "../src/memory/memory";
import { writeMemoryRecords } from "../src/memory/management";
import { MemoryAdapter } from "./helpers/memory-adapter";

const MEMORY_PATH = ".obsidian/plugins/agentic-chat/memory/memories.jsonl";
const NOW = Date.UTC(2026, 5, 28, 10, 11, 12);

type RenderCall =
  | { type: "clear" }
  | { type: "info"; title: string; entries: Array<[string, string]> }
  | { type: "error"; message: string }
  | { type: "actions"; title: string; subtitle: string; items: ActionRow[] };

function userMessage(content: string): AgentMessage {
  return { role: "user", content } as AgentMessage;
}

function memory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "mem-a",
    kind: "preference",
    scope: "vault",
    text: "The user prefers concise answers.",
    enabled: true,
    createdAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function renderer(): { calls: RenderCall[]; renderer: WorkflowRenderer } {
  const calls: RenderCall[] = [];
  return {
    calls,
    renderer: {
      clear: () => calls.push({ type: "clear" }),
      info: (title, entries) => calls.push({ type: "info", title, entries }),
      error: (message) => calls.push({ type: "error", message }),
      actionList: (title, subtitle, items) => calls.push({ type: "actions", title, subtitle, items }),
    },
  };
}

function makeController(options: {
  adapter?: MemoryAdapter;
  calls?: RenderCall[];
  messages?: AgentMessage[];
  scope?: MemoryScope;
  writeExport?: (filename: string, contents: string) => Promise<string>;
} = {}): { controller: MemoryWorkflowController; adapter: MemoryAdapter; calls: RenderCall[] } {
  const adapter = options.adapter ?? new MemoryAdapter();
  const existingRenderer = options.calls
    ? {
        renderer: {
          clear: () => options.calls?.push({ type: "clear" }),
          info: (title: string, entries: Array<[string, string]>) => options.calls?.push({ type: "info", title, entries }),
          error: (message: string) => options.calls?.push({ type: "error", message }),
          actionList: (title: string, subtitle: string, items: ActionRow[]) =>
            options.calls?.push({ type: "actions", title, subtitle, items }),
        } satisfies WorkflowRenderer,
        calls: options.calls,
      }
    : renderer();
  return {
    adapter,
    calls: existingRenderer.calls,
    controller: new MemoryWorkflowController({
      adapter: adapter.asDataAdapter(),
      memoryPath: () => MEMORY_PATH,
      messages: () => options.messages ?? [],
      defaultScope: () => options.scope ?? "vault",
      sessionSource: () => "[[Agentic Chat Sessions/session-1|Chat session]]",
      renderer: existingRenderer.renderer,
      writeExport: options.writeExport ?? (async (filename) => `Agentic Chat Exports/${filename}`),
      now: () => NOW,
    }),
  };
}

describe("MemoryWorkflowController", () => {
  it("adds a manual memory with optional kind and scope", async () => {
    const { controller, adapter, calls } = makeController();

    await controller.run("add preference global Prefer concise answers");

    const records = await loadMemoryRecords(adapter.asDataAdapter(), MEMORY_PATH);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: "preference",
      scope: "global",
      text: "Prefer concise answers.",
      tags: ["manual"],
      enabled: true,
      confidence: 1,
      source: "[[Agentic Chat Sessions/session-1|Chat session]]",
      provenance: [
        {
          source: "[[Agentic Chat Sessions/session-1|Chat session]]",
          extractedAt: new Date(NOW).toISOString(),
          note: "Manual /memory add",
        },
      ],
    });
    expect(calls).toContainEqual({ type: "info", title: "Memory", entries: [[records[0].id, "Saved."]] });
  });

  it("does not duplicate an enabled manual memory", async () => {
    const { controller, adapter, calls } = makeController();

    await controller.run("add Use exact source citations");
    await controller.run("add Use exact source citations.");

    const records = await loadMemoryRecords(adapter.asDataAdapter(), MEMORY_PATH);
    expect(records).toHaveLength(1);
    expect(calls).toContainEqual({
      type: "info",
      title: "Memory",
      entries: [["Use exact source citations.", `Already saved as ${records[0].id}.`]],
    });
  });

  it("rejects manual memories that look secret-like", async () => {
    const { controller, adapter, calls } = makeController();

    await controller.run("add API key is sk-test-secret");

    await expect(loadMemoryRecords(adapter.asDataAdapter(), MEMORY_PATH)).resolves.toEqual([]);
    expect(calls).toContainEqual({ type: "error", message: "Memory text looks like it may contain a secret. Not saved." });
  });

  it("renders review proposals as injected action rows with duplicate detail", async () => {
    const adapter = new MemoryAdapter();
    await writeMemoryRecords(adapter.asDataAdapter(), MEMORY_PATH, [memory({ id: "mem-existing", scope: "project" })]);
    const { controller, calls } = makeController({
      adapter,
      scope: "project",
      messages: [userMessage("I prefer concise answers.")],
    });

    await controller.run("review");

    const actionCall = calls.find((call): call is Extract<RenderCall, { type: "actions" }> => call.type === "actions");
    expect(actionCall?.title).toBe("Memory proposals");
    expect(actionCall?.items).toHaveLength(1);
    expect(actionCall?.items[0]).toMatchObject({
      label: "The user prefers concise answers.",
      detail: expect.stringContaining("duplicate: mem-existing"),
      icon: "sliders-horizontal",
    });
  });

  it("requires explicit confirmation before clearing stored memories", async () => {
    const adapter = new MemoryAdapter();
    await writeMemoryRecords(adapter.asDataAdapter(), MEMORY_PATH, [memory()]);
    const { controller, calls } = makeController({ adapter });

    await controller.run("clear");
    expect(calls.some((call) => call.type === "error" && call.message.includes("--confirm"))).toBe(true);
    await expect(loadMemoryRecords(adapter.asDataAdapter(), MEMORY_PATH)).resolves.toHaveLength(1);

    await controller.run("clear --confirm");
    expect(calls).toContainEqual({ type: "info", title: "Memory", entries: [["Deleted", "1 memory."]] });
    await expect(loadMemoryRecords(adapter.asDataAdapter(), MEMORY_PATH)).resolves.toEqual([]);
  });

  it("manages enabled memories and forgets records through the injected adapter", async () => {
    const adapter = new MemoryAdapter();
    await writeMemoryRecords(adapter.asDataAdapter(), MEMORY_PATH, [
      memory({ id: "mem-enabled" }),
      memory({ id: "mem-disabled", enabled: false, text: "Hidden memory." }),
    ]);
    const { controller, calls } = makeController({ adapter });

    await controller.run("manage");

    const actionCall = calls.find((call): call is Extract<RenderCall, { type: "actions" }> => call.type === "actions");
    expect(actionCall?.items.map((item) => item.detail)).toEqual(["mem-enabled · preference · vault"]);

    await controller.forget("mem-enabled");
    const records = await loadMemoryRecords(adapter.asDataAdapter(), MEMORY_PATH);
    expect(records.find((record) => record.id === "mem-enabled")).toMatchObject({
      enabled: false,
      forgetReason: "Forgotten from chat UI",
      forgottenAt: new Date(NOW).toISOString(),
    });
  });

  it("renders provenance and exports memory JSONL through the export hook", async () => {
    const adapter = new MemoryAdapter();
    const records = [memory({ id: "mem-source", source: "[[Notes/Source.md]]" })];
    await writeMemoryRecords(adapter.asDataAdapter(), MEMORY_PATH, records);
    const exports: Array<{ filename: string; contents: string }> = [];
    const { controller, calls } = makeController({
      adapter,
      writeExport: async (filename, contents) => {
        exports.push({ filename, contents });
        return `Agentic Chat Exports/${filename}`;
      },
    });

    await controller.run("provenance mem-source");
    expect(calls).toContainEqual({
      type: "info",
      title: "Memory provenance",
      entries: [["mem-source", expect.stringContaining("[[Notes/Source.md]]")]],
    });

    await controller.run("export");
    expect(exports[0]?.filename).toBe("Agentic chat memories 2026-06-28 10-11-12.jsonl");
    expect(parseMemoryRecords(exports[0]?.contents ?? "")).toEqual(records);
    expect(calls).toContainEqual({
      type: "info",
      title: "Memory",
      entries: [["Exported", "1 memories to Agentic Chat Exports/Agentic chat memories 2026-06-28 10-11-12.jsonl."]],
    });
  });
});
