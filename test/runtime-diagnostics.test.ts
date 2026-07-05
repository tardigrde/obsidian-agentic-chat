import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import {
  formatMcpDiagnosticRows,
  formatMcpDiagnosticSummary,
  formatRuntimeDiagnosticsRows,
  formatToolBudgetDiagnostic,
  summarizeAgentEvent,
} from "../src/agent/diagnostics";
import { replayTextTurn, replayToolCallTurn } from "../src/agent/replay-stream";
import { runAgentReplay } from "./helpers/agent-replay";

describe("runtime diagnostics", () => {
  it("summarizes tool events without leaking arguments or results", () => {
    const startEvent: AgentEvent = {
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "write",
      args: { path: "Private.md", content: "secret-token" },
    };
    const endEvent: AgentEvent = {
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "write",
      result: "secret-token",
      isError: false,
    };

    expect(summarizeAgentEvent(startEvent)).toBe("tool_execution_start:write#call-1");
    expect(summarizeAgentEvent(endEvent)).toBe("tool_execution_end:write#call-1:ok");
    expect(`${summarizeAgentEvent(startEvent)} ${summarizeAgentEvent(endEvent)}`).not.toContain("secret-token");
  });

  it("exposes a diagnostics snapshot after a deterministic replay", async () => {
    const result = await runAgentReplay({
      prompt: "Create a private note",
      settings: {
        mode: "plan",
        approval: {
          mutating: "ask",
          perTool: { delete: "deny" },
          workingDirs: ["Allowed"],
        },
      },
      turns: [
        replayToolCallTurn(
          "call-1",
          "write",
          { path: "Private.md", content: "secret-token" },
          { label: "blocked write" },
        ),
        replayTextTurn("I stayed read-only.", { label: "final" }),
      ],
    });

    const diagnostics = result.service.getRuntimeDiagnostics();
    expect(diagnostics.session.path).toMatch(/\.jsonl$/);
    expect(diagnostics.provider).toBe("openrouter");
    expect(diagnostics.model).toBe(result.settings.openrouterModel);
    expect(diagnostics.mode).toBe("plan");
    expect(diagnostics.approval).toMatchObject({
      mutating: "ask",
      perToolOverrides: 1,
      workingDirs: ["Allowed"],
    });
    expect(diagnostics.tools).toEqual(expect.arrayContaining(["read", "write", "subagent"]));
    expect(diagnostics.resources.lastReloadAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(diagnostics.toolBudget).toMatchObject({ enabled: true, active: false, thresholdPercent: 2 });
    expect(diagnostics.state.canUndo).toBe(false);
    expect(diagnostics.state.lastError).toBeNull();
    expect(diagnostics.recentEvents).toEqual(
      expect.arrayContaining([
        "tool_execution_start:write#call-1",
        "tool_execution_end:write#call-1:error",
      ]),
    );
    expect(diagnostics.recentEvents.join("\n")).not.toContain("secret-token");

    const rows = formatRuntimeDiagnosticsRows(diagnostics);
    expect(rows).toContainEqual(["Pending undo", "no"]);
    expect(rows).toContainEqual([
      "Tool budget",
      expect.stringMatching(/^armed at 2% tool schemas(?:; current tool schemas ~\d+ tokens)?$/),
    ]);
    expect(rows.some(([label]) => label === "Recent events")).toBe(true);
  });

  it("formats active tool budget diagnostics with dropped tool reasons", () => {
    expect(
      formatToolBudgetDiagnostic({
        enabled: true,
        active: true,
        thresholdPercent: 2,
        triggeredAtToolSchemaPercent: 3,
        toolSchemaTokens: 300,
        contextWindow: 10_000,
        droppedTools: [
          { name: "web_search", reason: "web egress" },
          { name: "mcp__docs__lookup", reason: "remote MCP" },
        ],
      }),
    ).toBe("active after 3% tool schemas; dropped: web_search (web egress), mcp__docs__lookup (remote MCP)");
  });

  it("formats MCP server and tool details for status blocks", () => {
    const servers = [
      {
        serverId: "team_docs",
        serverName: "Team Docs",
        url: "https://mcp.example.com/mcp",
        authType: "oauth" as const,
        approval: "ask",
        checkedAt: "2026-06-24T12:00:00.000Z",
        oauth: {
          hasAccessToken: true,
          hasRefreshToken: true,
          expiresAt: "2026-06-24T13:00:00.000Z",
          scope: "openid profile",
          authorizationServer: "https://auth.example.com",
        },
        status: "ok" as const,
        toolCount: 2,
        toolNames: ["query_company_knowledge", "search_docs"],
      },
    ];

    expect(formatMcpDiagnosticSummary(servers)).toBe("Team Docs=ok (2 tools)");
    expect(formatMcpDiagnosticRows(servers)).toEqual([
      ["MCP server: Team Docs", "ok (2 tools)"],
      ["MCP URL: Team Docs", "https://mcp.example.com/mcp"],
      [
        "MCP auth: Team Docs",
        "type=oauth, approval=ask, checked=2026-06-24T12:00:00.000Z, access=yes, refresh=yes, expires=2026-06-24T13:00:00.000Z, scope=openid profile, issuer=https://auth.example.com",
      ],
      ["MCP tools: Team Docs", "query_company_knowledge, search_docs"],
    ]);
  });
});
