import { describe, expect, it } from "vitest";
import type { AgentRuntimeDiagnostics } from "../src/agent/diagnostics";
import { buildDoctorReport, doctorDiagnosticsSummary, doctorStatusLine, type DoctorInput } from "../src/agent/doctor-report";
import type { LoadedPlugin } from "../src/plugins/loader";

/** U4 #17: `/doctor` as one object; problems first; a redacted summary for the session. */

const NOW = Date.parse("2026-11-21T12:00:00Z");

function diagnostics(overrides: Partial<AgentRuntimeDiagnostics> = {}): AgentRuntimeDiagnostics {
  return {
    session: { id: "s1", path: "sessions/s1.jsonl", name: "Plan", messageCount: 12 },
    provider: "openrouter",
    model: "deepseek/deepseek-v4.1-flash",
    modelOverride: null,
    contextWindow: 163_840,
    thinkingLevel: "off",
    mode: "safe",
    approval: { mutating: "ask", perToolOverrides: 0 },
    tools: ["read", "write", "vault_inspect"],
    resources: {
      skillCount: 3,
      profileCount: 1,
      hasInstructionsOverlay: false,
      lastReloadAt: null,
      mcpServers: [
        {
          serverId: "notion",
          serverName: "Notion",
          url: "https://mcp.notion.example/secret-path?token=abc",
          status: "error",
          error: "401 Unauthorized",
          authType: "oauth",
          approval: "ask",
          checkedAt: "2026-11-21T11:00:00Z",
          toolCount: 0,
          toolNames: [],
        } as never,
      ],
    },
    observability: { enabled: false, backend: "langfuse", endpointConfigured: false, payloadMode: "metadata", sampleRate: 100, exportHealth: { attemptedExports: 0, successfulExports: 0, failedExports: 0, droppedTraces: 0 } as never },
    state: { isStreaming: false, canUndo: false, lastError: null, contextPercent: 41, compactionCount: 1, totalTokens: 52_000 },
    recentEvents: ["agent_start", "tool_execution_start:read#c1"],
    ...overrides,
  };
}

function plugin(name: string, auditStatus: string, skills: string[]): LoadedPlugin {
  return { name, enabled: true, auditStatus, skills: skills.map((skill) => ({ name: skill })) } as unknown as LoadedPlugin;
}

function input(overrides: Partial<DoctorInput> = {}): DoctorInput {
  return {
    diagnostics: diagnostics(),
    plugins: [plugin("builtins", "ok", ["self-knowledge"]), plugin("broken", "failed", [])],
    pluginsFolder: ".agentic-plugins",
    catalog: { fetchedAt: NOW - 2 * 24 * 3_600_000, outdated: true, models: 477, lastError: "OpenRouter models API returned 503", failedAttempts: 2 },
    sessionCostUsd: 0.0123,
    subagentCostUsd: 0.004,
    hasApiKey: true,
    builtinSkillNames: ["self-knowledge", "deep-research", "install-plugin"],
    now: NOW,
    ...overrides,
  };
}

describe("buildDoctorReport", () => {
  it("lists problems first, each with a fix: a failed plugin, a failing MCP server, a stale catalog", () => {
    const report = buildDoctorReport(input());
    expect(report.status).toBe("warn");
    expect(doctorStatusLine(report)).toBe("⚠️ 3 problems");
    expect(report.problems.map((problem) => problem.code)).toEqual(["plugin_failed", "mcp_error", "catalog_stale"]);
    expect(report.problems.find((problem) => problem.code === "catalog_stale")?.text).toMatch(/^Model list 2 days old, last fetch failed/);
    expect(report.problems.every((problem) => problem.fix.length > 0)).toBe(true);
  });

  it("all fine reads ✅ All OK, with the session cost including subagents in the essentials", () => {
    const report = buildDoctorReport(
      input({
        diagnostics: diagnostics({ resources: { ...diagnostics().resources, mcpServers: [] } }),
        plugins: [],
        catalog: { fetchedAt: NOW - 3_600_000, outdated: false, models: 477, lastError: null, failedAttempts: 0 },
      }),
    );
    expect(doctorStatusLine(report)).toBe("✅ All OK");
    expect(report.essentials).toContainEqual(["Cost", "$0.01 (subagents $0.0040)"]);
  });

  it("notes a vault skill that overrides a built-in, and folds names into sections with counts on top", () => {
    const report = buildDoctorReport(input());
    expect(report.notes).toEqual(['ℹ️ The vault skill "self-knowledge" (plugin builtins) overrides the built-in one.']);
    expect(report.sections.map((section) => `${section.title} · ${section.summary}`)).toEqual([
      "Session and cost · 12 messages · $0.01 · 1 compactions",
      "Plugins · 1 loaded, 1 failed · 3 skills",
      "MCP · 0 ok, 1 failing",
      "Tools · 3 active",
      "Debug · 2 recent events",
    ]);
  });

  it("the session summary holds codes and counts only: no names, URLs, or error text", () => {
    const report = buildDoctorReport(input());
    const summary = doctorDiagnosticsSummary(report, input());
    expect(summary).toMatchObject({
      status: "warn",
      problems: ["plugin_failed", "mcp_error", "catalog_stale"],
      counts: { plugins: 2, pluginsFailed: 1, mcp: 1, mcpFailed: 1, tools: 3, skills: 3, messages: 12, compactions: 1 },
      contextPercent: 41,
      catalogAgeHours: 48,
    });
    const text = JSON.stringify(summary);
    for (const leak of ["Notion", "notion.example", "token", "401", "broken", "Plan"]) expect(text).not.toContain(leak);
  });
});
