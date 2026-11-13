import { describe, expect, it } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { App } from "obsidian";
import { DEFAULT_SETTINGS } from "../src/settings-schema";
import { buildAgentParentTools } from "../src/agent/runtime-resources";
import { estimateToolDefinitionTokens } from "../src/agent/tool-budget";
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
  const { tools } = buildAgentParentTools({
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
  return tools;
}

describe("tool schema token budget", () => {
  it("keeps the full parent tool set under 2800 model-visible schema tokens", () => {
    const tokens = estimateToolDefinitionTokens(parentTools(false));
    // Measured with pi-ai's 3.5 chars-per-token ratio, the same one the context
    // readout uses. This ceiling guards against prose creeping back in.
    expect(tokens).toBeLessThan(2800);
  });

  it("keeps the production parent tool set (with create_skill) under the same ceiling", () => {
    const tokens = estimateToolDefinitionTokens(parentTools(true));
    // create_skill adds ~750 tokens of schema (name/description/body/overwrite
    // params + safety description). Production already carries MCP tools on top,
    // so this ceiling only guards prose creep in the fixed test config.
    expect(tokens).toBeLessThan(3000);
  });

  it("keeps the default vault surface under 1000 tokens (eval max_tool_schema_tokens is 1200)", () => {
    const tokens = estimateToolDefinitionTokens(createVaultTools({} as App) as AgentTool[]);
    expect(tokens).toBeLessThan(1000);
  });
});
