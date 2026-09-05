import { describe, expect, it } from "vitest";
import { MemoryWorkflowController } from "../src/ui/memory-workflow-controller";
import type { WorkflowRenderer } from "../src/ui/workflow-renderer";
import { DEFAULT_SETTINGS } from "../src/settings-schema";
import { MemoryAdapter } from "./helpers/memory-adapter";

type RenderCall =
  | { type: "clear" }
  | { type: "info"; title: string; entries: Array<[string, string]> }
  | { type: "error"; message: string };

function renderer(): { calls: RenderCall[]; renderer: WorkflowRenderer } {
  const calls: RenderCall[] = [];
  return {
    calls,
    renderer: {
      clear: () => calls.push({ type: "clear" }),
      info: (title, entries) => calls.push({ type: "info", title, entries }),
      error: (message) => calls.push({ type: "error", message }),
      actionList: () => {
        throw new Error("not used");
      },
    },
  };
}

function makeController(options: {
  adapter?: MemoryAdapter;
  enabled?: boolean;
  store?: "plugin" | "vault";
} = {}) {
  const adapter = options.adapter ?? new MemoryAdapter();
  const { calls, renderer: render } = renderer();
  const controller = new MemoryWorkflowController({
    adapter: adapter.asDataAdapter(),
    getSettings: () => ({
      ...DEFAULT_SETTINGS,
      memory: {
        enabled: options.enabled ?? true,
        store: options.store ?? "plugin",
        vaultFolder: "memory",
        modelOverride: "",
      },
    }),
    configDir: ".obsidian",
    messages: () => [],
    sessionSource: () => undefined,
    renderer: render,
    now: () => Date.UTC(2026, 5, 28, 10, 11, 12),
  });
  return { controller, adapter, calls };
}

describe("MemoryWorkflowController (Tier-1 + Tier-2)", () => {
  it("adds a manual daily memory", async () => {
    const { controller, adapter, calls } = makeController();

    await controller.run("add Prefer concise answers");

    const daily = await adapter.read(".obsidian/plugins/agentic-chat/memory/daily/2026-06-28.md");
    expect(daily).toContain("Prefer concise answers.");
    expect(calls).toContainEqual({
      type: "info",
      title: "Memory",
      entries: [[expect.stringContaining("daily/2026-06-28.md"), "Saved to today's daily note."]],
    });
  });

  it("rejects secret-like manual memories", async () => {
    const { controller, calls } = makeController();

    await controller.run("add api_key = sk-test-secret-value");

    expect(calls).toContainEqual({ type: "error", message: "Memory text looks like it may contain a secret. Not saved." });
  });

  it("refuses to work when disabled", async () => {
    const { controller, calls } = makeController({ enabled: false });

    await controller.run("add hello");
    await controller.run("distill");

    expect(calls.filter((call) => call.type === "error")).toHaveLength(2);
  });

  it("rejects unknown subcommands with the two-command usage", async () => {
    const { controller, calls } = makeController();

    await controller.run("review");

    expect(calls).toContainEqual({
      type: "error",
      message: 'Unknown memory command "review". Try /memory add <text> or /memory distill.',
    });
  });

  it("distills seeded dailies into MEMORY.md on demand", async () => {
    const { controller, adapter, calls } = makeController();
    await adapter.write(
      ".obsidian/plugins/agentic-chat/memory/daily/2026-06-28.md",
      "## 2026-06-28\n\n- The user prefers concise answers.\n",
    );

    await controller.run("distill");

    const memory = await adapter.read(".obsidian/plugins/agentic-chat/memory/MEMORY.md");
    expect(memory).toContain("The user prefers concise answers.");
    expect(memory).toContain("<!-- AGENTIC-CHAT-AUTO-MEMORY -->");
    expect(calls).toContainEqual({
      type: "info",
      title: "Memory",
      entries: [["MEMORY.md", expect.stringContaining("Distilled")]],
    });
  });
});
