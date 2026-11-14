import { describe, expect, it } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { App } from "obsidian";
import { buildAgentParentTools, EMPTY_AGENT_RUNTIME_RESOURCES } from "../src/agent/runtime-resources";
import { createSubagentTool } from "../src/tools/subagent-tool";
import { ReadMemo } from "../src/vault/read-memo";
import { noopArtifactStore } from "./support/fake-adapter";
import { DEFAULT_SETTINGS, mergeSettings } from "../src/settings-schema";
import { SETTINGS_SECTION_IDS } from "../src/settings-tabs";
import { resolveCommand, retiredCommandHint, SLASH_COMMANDS } from "../src/ui/commands";

/**
 * Witness for the November 2026 feature cut
 * (docs/development/feature-cut-2026-11.md). Each test proves that one removed
 * entry point is gone.
 */
const commandNames = (): string[] => SLASH_COMMANDS.map((command) => command.name);

/** The full parent tool list: web on, ask_user, subagent, and create_skill present, no tool budget. */
function parentToolNames(): string[] {
  const subagentTool = createSubagentTool({
    getProfiles: () => [],
    createChildAgent: () => {
      throw new Error("n/a");
    },
  }) as unknown as AgentTool;
  const { tools } = buildAgentParentTools({
    app: { vault: {}, workspace: {} } as unknown as App,
    settings: {
      ...DEFAULT_SETTINGS,
      web: { ...DEFAULT_SETTINGS.web, enabled: true },
      toolBudget: { enabled: false, thresholdPercent: 2 },
    },
    resources: EMPTY_AGENT_RUNTIME_RESOURCES,
    readMemo: new ReadMemo(),
    webFetch: async () => ({ status: 200, text: "", headers: {} }),
    artifactStore: noopArtifactStore,
    askUser: async () => "answer",
    subagentTool,
    skillScaffolder: {
      packageExists: async () => false,
      async scaffoldSkill() {
        return { rootPath: ".agentic-plugins/x", name: "x", updated: false, skills: 1 };
      },
    },
  });
  return tools.map((tool) => tool.name);
}

function mergedKeys(stored: Record<string, unknown>): string[] {
  return Object.keys(mergeSettings(stored as never));
}

describe("feature cut 2026-11: output styles", () => {
  it("does not register /style and shows a retired hint", () => {
    expect(commandNames()).not.toContain("style");
    expect(resolveCommand("style")).toBeUndefined();
    expect(retiredCommandHint("style")).toContain("/style was removed");
  });

  it("drops the outputStyle setting on load", () => {
    expect(Object.keys(DEFAULT_SETTINGS)).not.toContain("outputStyle");
    expect(mergedKeys({ outputStyle: "learning" })).not.toContain("outputStyle");
  });
});

describe("feature cut 2026-11: memory", () => {
  it("does not register /memory and shows a retired hint", () => {
    expect(commandNames()).not.toContain("memory");
    expect(resolveCommand("memory")).toBeUndefined();
    expect(retiredCommandHint("memory")).toContain("/memory was removed");
  });

  it("does not give the model the search_memory tool", () => {
    expect(parentToolNames()).not.toContain("search_memory");
  });
});

describe("feature cut 2026-11: semantic index", () => {
  it("does not register /semantic-index and shows a retired hint", () => {
    expect(commandNames()).not.toContain("semantic-index");
    expect(resolveCommand("semantic-index")).toBeUndefined();
    expect(retiredCommandHint("semantic-index")).toContain("/semantic-index was removed");
  });

  it("drops the embeddings settings on load", () => {
    expect(Object.keys(DEFAULT_SETTINGS)).not.toContain("embeddings");
    expect(mergedKeys({ embeddings: { enabled: true, provider: "ollama" } })).not.toContain("embeddings");
  });

  it("has no semantic retrieval settings section", () => {
    expect(SETTINGS_SECTION_IDS).not.toContain("retrieval");
    expect(SETTINGS_SECTION_IDS).toContain("ignored-files");
  });
});
