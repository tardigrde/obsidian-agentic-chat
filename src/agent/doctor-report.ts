import type { LoadedPlugin } from "../plugins/loader";
import type { ModelCatalogStatus } from "../llm/pricing-cache";
import type { AgentRuntimeDiagnostics } from "./diagnostics";
import { formatMcpDiagnosticRows } from "./diagnostics";

/**
 * `/doctor` as one object (U4 #17, owner decision 2026-11-21): problems first,
 * each with a fix; then the essentials; then folded sections. The same object
 * yields a small redacted `diagnostics` entry for the session, so the chaos
 * miner sees what `/doctor` saw.
 */

export type DoctorSeverity = "error" | "warn";

export interface DoctorProblem {
  /** Stable code for the miner and tests: `mcp_error`, `catalog_stale`, ... */
  code: string;
  severity: DoctorSeverity;
  text: string;
  fix: string;
}

export interface DoctorSection {
  title: string;
  /** Counts on the folded line: `3 loaded, 1 failed`. */
  summary: string;
  rows: Array<[string, string]>;
}

export interface DoctorReport {
  status: "ok" | "warn" | "error";
  problems: DoctorProblem[];
  essentials: Array<[string, string]>;
  /** Informational notes (not problems), e.g. a vault skill overriding a built-in. */
  notes: string[];
  sections: DoctorSection[];
}

export interface DoctorInput {
  diagnostics: AgentRuntimeDiagnostics;
  plugins: readonly LoadedPlugin[];
  pluginsFolder: string;
  catalog: ModelCatalogStatus;
  /** Session cost in USD, subagents included, and the subagent part. */
  sessionCostUsd: number;
  subagentCostUsd: number;
  hasApiKey: boolean;
  builtinSkillNames: readonly string[];
  now?: number;
}

/** A catalog older than this is a problem when its last fetch failed. */
const CATALOG_STALE_MS = 24 * 60 * 60 * 1000;

const STATUS_EMOJI: Record<DoctorReport["status"], string> = { ok: "✅", warn: "⚠️", error: "❌" };
const SEVERITY_EMOJI: Record<DoctorSeverity, string> = { error: "❌", warn: "⚠️" };

export function buildDoctorReport(input: DoctorInput): DoctorReport {
  const { diagnostics: d } = input;
  const now = input.now ?? Date.now();
  const problems: DoctorProblem[] = [];

  if (!input.hasApiKey && d.provider !== "ollama") {
    problems.push({ code: "no_api_key", severity: "error", text: `No API key for ${d.provider}.`, fix: "Settings → Provider: add the key." });
  }
  const failedPlugins = input.plugins.filter((plugin) => plugin.auditStatus === "failed");
  for (const plugin of failedPlugins) {
    problems.push({
      code: "plugin_failed",
      severity: "warn",
      text: `Agent plugin "${plugin.name}" did not load.`,
      fix: `Open ${input.pluginsFolder}/${plugin.name} and fix its plugin.json, or disable it in Settings → Plugins.`,
    });
  }
  for (const server of d.resources.mcpServers.filter((entry) => entry.status === "error")) {
    problems.push({
      code: "mcp_error",
      severity: "warn",
      text: `MCP server "${server.serverName}" fails: ${server.error ?? "unknown error"}.`,
      fix: server.authType === "oauth" ? "Settings → MCP: sign in again." : "Settings → MCP: check the URL and the key, then Test.",
    });
  }
  if (d.state.lastError) {
    problems.push({ code: "last_error", severity: "warn", text: `The last run ended in an error: ${d.state.lastError}`, fix: "Ask again, or switch the model." });
  }
  if (d.observability.enabled && d.observability.exportHealth.failedExports > 0) {
    problems.push({
      code: "observability_export",
      severity: "warn",
      text: `Observability exports fail (${d.observability.exportHealth.failedExports}).`,
      fix: "Settings → Advanced → Observability: check the endpoint and keys.",
    });
  }
  if (d.provider === "openrouter") {
    const age = input.catalog.fetchedAt > 0 ? now - input.catalog.fetchedAt : Number.POSITIVE_INFINITY;
    const failed = input.catalog.lastError !== null;
    if (failed && (age > CATALOG_STALE_MS || input.catalog.outdated)) {
      const days = Number.isFinite(age) ? `${Math.max(1, Math.round(age / CATALOG_STALE_MS))} day${Math.round(age / CATALOG_STALE_MS) === 1 ? "" : "s"} old` : "missing";
      problems.push({
        code: "catalog_stale",
        severity: "warn",
        text: `Model list ${days}, last fetch failed (${input.catalog.lastError}). Prices and image support may be off.`,
        fix: "It retries on its own; check the network or proxy if this stays.",
      });
    }
  }

  const status: DoctorReport["status"] = problems.some((problem) => problem.severity === "error")
    ? "error"
    : problems.length > 0
      ? "warn"
      : "ok";

  const model = d.modelOverride ? `${d.model} (next message only)` : d.model;
  const essentials: Array<[string, string]> = [
    ["Model", `${d.provider} · ${model}`],
    ["Mode", `${d.mode} · approval ${d.approval.mutating}`],
    ["Context", d.state.contextPercent === null ? "unknown" : `${d.state.contextPercent}%`],
    ["Cost", formatUsd(input.sessionCostUsd) + (input.subagentCostUsd > 0 ? ` (subagents ${formatUsd(input.subagentCostUsd)})` : "")],
  ];

  const overridden = input.plugins
    .filter((plugin) => plugin.enabled)
    .flatMap((plugin) => plugin.skills.map((skill) => ({ plugin: plugin.name, skill: skill.name })))
    .filter((entry) => input.builtinSkillNames.includes(entry.skill));
  const notes = overridden.map((entry) => `ℹ️ The vault skill "${entry.skill}" (plugin ${entry.plugin}) overrides the built-in one.`);

  const okPlugins = input.plugins.length - failedPlugins.length;
  const mcp = d.resources.mcpServers;
  const mcpFailed = mcp.filter((server) => server.status === "error").length;
  const sections: DoctorSection[] = [
    {
      title: "Session and cost",
      summary: `${d.session.messageCount} messages · ${formatUsd(input.sessionCostUsd)} · ${d.state.compactionCount} compactions`,
      rows: [
        ["Session", d.session.name ?? d.session.id ?? "(none)"],
        ["File", d.session.path ?? "(none)"],
        ["Tokens", d.state.totalTokens.toLocaleString("en-US")],
        ["Cost", formatUsd(input.sessionCostUsd)],
        ["Subagents", formatUsd(input.subagentCostUsd)],
        ["Compactions", String(d.state.compactionCount)],
        ["Last error", d.state.lastError ?? "(none)"],
        ["Undo available", d.state.canUndo ? "yes" : "no"],
      ],
    },
    {
      title: "Plugins",
      summary: `${okPlugins} loaded${failedPlugins.length > 0 ? `, ${failedPlugins.length} failed` : ""} · ${d.resources.skillCount} skills`,
      rows: input.plugins.length === 0
        ? [["Plugins", `none in ${input.pluginsFolder}`]]
        : input.plugins.map((plugin): [string, string] => [
            plugin.name,
            `${plugin.enabled ? "on" : "off"} · ${plugin.auditStatus} · ${plugin.skills.length} skills`,
          ]),
    },
    {
      title: "MCP",
      summary: mcp.length === 0 ? "none" : `${mcp.length - mcpFailed} ok${mcpFailed > 0 ? `, ${mcpFailed} failing` : ""}`,
      rows: mcp.length === 0 ? [["MCP", "(none)"]] : formatMcpDiagnosticRows(mcp),
    },
    {
      title: "Tools",
      summary: `${d.tools.length} active`,
      rows: [["Active", d.tools.join(", ") || "(none)"]],
    },
    {
      title: "Debug",
      summary: `${d.recentEvents.length} recent events`,
      rows: d.recentEvents.slice(-12).map((event, index): [string, string] => [`#${index + 1}`, event]),
    },
  ];

  return { status, problems, essentials, notes, sections };
}

/** The one-line status: `✅ All OK` or `⚠️ 2 problems`. */
export function doctorStatusLine(report: DoctorReport): string {
  if (report.problems.length === 0) return `${STATUS_EMOJI.ok} All OK`;
  const count = report.problems.length;
  return `${STATUS_EMOJI[report.status]} ${count} problem${count === 1 ? "" : "s"}`;
}

export function doctorProblemLine(problem: DoctorProblem): string {
  return `${SEVERITY_EMOJI[problem.severity]} ${problem.text}`;
}

/**
 * The redacted entry `/doctor` appends to the session: codes and counts only,
 * never URLs, keys, names, or error text.
 */
export interface DoctorDiagnosticsSummary {
  status: DoctorReport["status"];
  problems: string[];
  counts: {
    plugins: number;
    pluginsFailed: number;
    mcp: number;
    mcpFailed: number;
    tools: number;
    skills: number;
    messages: number;
    compactions: number;
  };
  contextPercent: number | null;
  catalogAgeHours: number | null;
}

export function doctorDiagnosticsSummary(report: DoctorReport, input: DoctorInput): DoctorDiagnosticsSummary {
  const d = input.diagnostics;
  const now = input.now ?? Date.now();
  return {
    status: report.status,
    problems: report.problems.map((problem) => problem.code),
    counts: {
      plugins: input.plugins.length,
      pluginsFailed: input.plugins.filter((plugin) => plugin.auditStatus === "failed").length,
      mcp: d.resources.mcpServers.length,
      mcpFailed: d.resources.mcpServers.filter((server) => server.status === "error").length,
      tools: d.tools.length,
      skills: d.resources.skillCount,
      messages: d.session.messageCount,
      compactions: d.state.compactionCount,
    },
    contextPercent: d.state.contextPercent,
    catalogAgeHours: input.catalog.fetchedAt > 0 ? Math.round((now - input.catalog.fetchedAt) / 3_600_000) : null,
  };
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0.00";
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}
