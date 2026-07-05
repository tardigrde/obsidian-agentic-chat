import { describe, expect, it } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  applyToolBudget,
  createToolBudgetState,
  toolBudgetDropReason,
  type ToolBudgetSettings,
} from "../src/agent/tool-budget";

const settings: ToolBudgetSettings = { enabled: true, thresholdPercent: 2 };

function tools(names: string[]): AgentTool[] {
  return names.map((name) => ({ name, label: name }) as AgentTool);
}

describe("tool budget", () => {
  it("keeps the full tool set below the tool-schema threshold", () => {
    const state = createToolBudgetState();
    const result = applyToolBudget({
      tools: tools(["read", "write", "web_search", "subagent"]),
      settings,
      state,
      contextWindow: 100_000,
    });

    expect(result.tools.map((tool) => tool.name)).toEqual(["read", "write", "web_search", "subagent"]);
    expect(result.snapshot).toMatchObject({
      active: false,
      thresholdPercent: 2,
      contextWindow: 100_000,
      droppedTools: [],
    });
  });

  it("drops optional expansion tools when tool schemas exceed the threshold", () => {
    const state = createToolBudgetState();
    const result = applyToolBudget({
      tools: tools([
        "read",
        "write",
        "ask_user",
        "search_memory",
        "external_inspect",
        "import_pdf",
        "import_document",
        "web_search",
        "fetch_url",
        "list_artifacts",
        "read_artifact",
        "search_artifact",
        "export_artifact",
        "mcp__docs__lookup",
        "subagent",
      ]),
      settings,
      state,
      contextWindow: 500,
    });

    expect(result.tools.map((tool) => tool.name)).toEqual([
      "read",
      "write",
      "ask_user",
      "search_memory",
      "external_inspect",
    ]);
    expect(result.snapshot).toMatchObject({
      active: true,
      contextWindow: 500,
      droppedTools: [
        { name: "import_pdf", reason: "document import" },
        { name: "import_document", reason: "document import" },
        { name: "web_search", reason: "web egress" },
        { name: "fetch_url", reason: "web egress" },
        { name: "list_artifacts", reason: "artifact lookup" },
        { name: "read_artifact", reason: "artifact lookup" },
        { name: "search_artifact", reason: "artifact lookup" },
        { name: "export_artifact", reason: "artifact lookup" },
        { name: "mcp__docs__lookup", reason: "remote MCP" },
        { name: "subagent", reason: "subagent delegation" },
      ],
    });
    expect(result.snapshot.triggeredAtToolSchemaPercent).toBeGreaterThanOrEqual(2);
    expect(result.snapshot.toolSchemaTokens).toBeGreaterThan(0);
  });

  it("restores optional tools once tool schemas are below the threshold", () => {
    const state = createToolBudgetState();
    applyToolBudget({
      tools: tools(["read", "web_search"]),
      settings,
      state,
      contextWindow: 200,
    });

    const result = applyToolBudget({
      tools: tools(["read", "web_search", "mcp__fresh__search"]),
      settings,
      state,
      contextWindow: 100_000,
    });

    expect(result.tools.map((tool) => tool.name)).toEqual(["read", "web_search", "mcp__fresh__search"]);
    expect(result.snapshot).toMatchObject({ active: false, droppedTools: [] });
  });

  it("disabling the budget clears session drops", () => {
    const state = createToolBudgetState();
    applyToolBudget({
      tools: tools(["read", "subagent"]),
      settings,
      state,
      contextWindow: 200,
    });

    const disabled = applyToolBudget({
      tools: tools(["read", "subagent"]),
      settings: { enabled: false, thresholdPercent: 2 },
      state,
      contextWindow: 200,
    });

    expect(disabled.tools.map((tool) => tool.name)).toEqual(["read", "subagent"]);
    expect(disabled.snapshot).toMatchObject({ enabled: false, active: false, droppedTools: [] });
  });

  it("classifies only optional tool surfaces as droppable", () => {
    expect(toolBudgetDropReason("read")).toBeNull();
    expect(toolBudgetDropReason("write")).toBeNull();
    expect(toolBudgetDropReason("ask_user")).toBeNull();
    expect(toolBudgetDropReason("search_memory")).toBeNull();
    expect(toolBudgetDropReason("external_inspect")).toBeNull();
    expect(toolBudgetDropReason("web_search")).toBe("web egress");
    expect(toolBudgetDropReason("mcp__docs__lookup")).toBe("remote MCP");
  });
});
