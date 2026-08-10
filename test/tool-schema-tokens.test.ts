import { describe, expect, it } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { App } from "obsidian";
import { DEFAULT_SETTINGS } from "../src/settings";
import { buildAgentParentTools } from "../src/agent/runtime-resources";
import { estimateToolDefinitionTokens } from "../src/agent/tool-budget";
import { createSubagentTool } from "../src/tools/subagent-tool";
import { createVaultTools } from "../src/tools/vault-tools";
import type { ToolArtifactStoreLike } from "../src/artifacts/tool-artifact-store";
import type { WebFetcher } from "../src/tools/web-fetch";
import { ReadMemo } from "../src/vault/read-memo";

const noopFetcher: WebFetcher = async () => ({ status: 200, text: "", headers: {} });
const noopArtifactStore: ToolArtifactStoreLike = {
  async writeArtifact(input) {
    return {
      id: "a",
      label: input.label,
      sourceToolName: input.sourceToolName,
      contentType: input.contentType ?? "text/plain",
      createdAt: "2026-06-24T00:00:00.000Z",
      charLength: input.text.length,
    };
  },
  async readArtifact() {
    return {
      metadata: {
        id: "a",
        label: "A",
        sourceToolName: "t",
        contentType: "text/plain",
        createdAt: "2026-06-24T00:00:00.000Z",
        charLength: 0,
      },
      text: "",
    };
  },
};

function parentTools(): AgentTool[] {
  const subagentTool = createSubagentTool({
    getProfiles: () => [],
    createChildAgent: () => {
      throw new Error("n/a");
    },
  }) as unknown as AgentTool;
  const { tools } = buildAgentParentTools({
    app: { vault: {}, workspace: {} } as unknown as App,
    settings: { ...DEFAULT_SETTINGS, web: { ...DEFAULT_SETTINGS.web, enabled: true } },
    resources: {
      skills: [],
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
  });
  return tools;
}

describe("tool schema token budget", () => {
  it("keeps the full parent tool set under 2200 model-visible schema tokens", () => {
    const tokens = estimateToolDefinitionTokens(parentTools());
    // Trimmed tool descriptions are a per-turn context + cost win and keep the
    // tool budget (2% of a 128k window = 2560) from silently dropping optional
    // tools. This ceiling guards against prose creeping back in.
    expect(tokens).toBeLessThan(2200);
  });

  it("keeps the default vault surface under 1000 tokens (eval max_tool_schema_tokens is 1200)", () => {
    const tokens = estimateToolDefinitionTokens(createVaultTools({} as App) as AgentTool[]);
    expect(tokens).toBeLessThan(1000);
  });
});
