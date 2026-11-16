import { describe, expect, it } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { App } from "obsidian";
import { DEFAULT_SETTINGS } from "../src/settings-schema";
import { buildAgentParentTools } from "../src/agent/runtime-resources";
import { estimateToolDefinitionTokens } from "../src/agent/tool-schema-tokens";
import { createSubagentTool } from "../src/tools/subagent-tool";
import { createVaultTools } from "../src/tools/vault-tools";
import type { WebFetcher } from "../src/tools/web-fetch";
import { ReadMemo } from "../src/vault/read-memo";
import { noopArtifactStore } from "./support/fake-adapter";

const noopFetcher: WebFetcher = async () => ({ status: 200, text: "", headers: {} });

function parentTools(withScaffolder: boolean): AgentTool[] {
  const subagentTool = createSubagentTool({
    getProfiles: () => [],
    createChildAgent: () => {
      throw new Error("n/a");
    },
  }) as unknown as AgentTool;
  const scaffolder = {
    packageExists: async () => false,
    async scaffoldSkill() {
      return { rootPath: ".agentic-plugins/x", name: "x", updated: false, skills: 1 };
    },
  };
  const { active } = buildAgentParentTools({
    app: { vault: {}, workspace: {} } as unknown as App,
    settings: { ...DEFAULT_SETTINGS, web: { ...DEFAULT_SETTINGS.web, enabled: true } },
    resources: {
      skills: [],
      plugins: [],
      profiles: [],
      instructionsOverlay: "",
      ignoreMatcher: () => false,
      mcpTools: [],
      mcpDiagnostics: [],
    },
    readMemo: new ReadMemo(),
    webFetch: noopFetcher,
    artifactStore: noopArtifactStore,
    askUser: async () => "answer",
    subagentTool,
    ...(withScaffolder ? { skillScaffolder: scaffolder } : {}),
  });
  return active;
}

describe("tool schema token ceiling", () => {
  it("keeps the active parent tool set under 2400 model-visible schema tokens", () => {
    const tokens = estimateToolDefinitionTokens(parentTools(false));
    // 14 always-loaded tools, measured at 3.5 chars/token (about 2240 on
    // 2026-11-16, down from 2663 for the 20 tools before tool consolidation).
    // This ceiling guards against prose creeping back into descriptions.
    expect(tokens).toBeLessThan(2400);
  });

  it("does not grow the active set with create_skill: it is deferred behind search_tools", () => {
    expect(estimateToolDefinitionTokens(parentTools(true))).toBe(estimateToolDefinitionTokens(parentTools(false)));
  });

  it("keeps the default vault surface under 1000 tokens (eval max_tool_schema_tokens is 1200)", () => {
    const tokens = estimateToolDefinitionTokens(createVaultTools({} as App) as AgentTool[]);
    expect(tokens).toBeLessThan(1000);
  });
});
