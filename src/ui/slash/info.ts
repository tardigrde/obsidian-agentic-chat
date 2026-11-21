import type { LoadedPlugin } from "../../plugins/loader";
import { buildDoctorReport, doctorDiagnosticsSummary, type DoctorInput } from "../../agent/doctor-report";
import { modelCatalogStatus } from "../../llm/pricing-cache";
import { sumSubagentResultUsage } from "../../agent/session-usage";
import { BUILTIN_SKILL_NAMES } from "../../skills/builtin-skills";
import { activeModelId } from "../../settings-schema";
import { MODES } from "../../agent/modes";
import { formatMcpDiagnosticRows, formatMcpDiagnosticSummary } from "../../agent/diagnostics";
import { errorMessage } from "../../utils/errors";
import { formatDetailedUsage } from "../format";
import { visibleCommands } from "../commands";
import type { SlashContext } from "./context";

/**
 * `/doctor` (U4 #17): problems first, each with a fix; then the essentials;
 * then closed sections. It also appends a redacted `diagnostics` entry
 * (codes and counts) to the session, so the chaos miner sees what it saw.
 */
export async function runDoctor(ctx: SlashContext): Promise<void> {
  ctx.clearEmptyState();
  const service = ctx.plugin.pluginService;
  let plugins: LoadedPlugin[];
  try {
    plugins = await service.reload();
    // Diagnostics come from the active session's runtime resources, which
    // only reload per turn; refresh them so the audit and the health rows
    // describe the same vault state.
    await ctx.service.reloadRuntimeResources();
  } catch (error) {
    ctx.renderErrorMessage(`Doctor audit failed: ${errorMessage(error)}`);
    return;
  }
  const input: DoctorInput = {
    diagnostics: ctx.service.getRuntimeDiagnostics(),
    plugins,
    pluginsFolder: ctx.plugin.settings.plugins.folder || ".agentic-plugins",
    catalog: modelCatalogStatus(),
    sessionCostUsd: ctx.service.getSessionUsage().cost?.total ?? 0,
    subagentCostUsd: sumSubagentResultUsage(ctx.service.getMessages()).usage.cost.total,
    hasApiKey: ctx.service.hasProviderKey(),
    builtinSkillNames: BUILTIN_SKILL_NAMES,
  };
  const report = buildDoctorReport(input);
  ctx.renderDoctorReport(report);
  try {
    await ctx.service.recordDiagnostics({ ...doctorDiagnosticsSummary(report, input) });
  } catch (error) {
    console.warn("Agentic Chat: could not save the /doctor summary to the session.", error);
  }
}

export function showStatus(ctx: SlashContext): void {
  const { settings } = ctx.plugin;
  const session = ctx.service.getSessionInfo();
  const override = ctx.service.getModelOverride();
  const diagnostics = ctx.service.getRuntimeDiagnostics();
  ctx.clearEmptyState();
  ctx.renderInfoMessage("Status", [
    ["Provider", settings.provider],
    ["Model", override ? `${override} (next message only)` : activeModelId(settings)],
    ["Mode", MODES[settings.mode].label],
    // The active level, i.e. the configured level clamped to what the model
    // actually supports — the raw setting alone can overstate the next turn.
    ["Thinking", ctx.service.getActiveThinkingLevel()],
    ["Approval (mutating)", settings.approval.mutating],
    ["Session", session ? `${session.messageCount} messages` : "(none)"],
    ["MCP", formatMcpDiagnosticSummary(diagnostics.resources.mcpServers)],
    ...formatMcpDiagnosticRows(diagnostics.resources.mcpServers),
  ]);
}

export function showUsage(ctx: SlashContext): void {
  const usage = ctx.service.getSessionUsage();
  ctx.clearEmptyState();
  ctx.renderInfoMessage(
    "Usage",
    usage.totalTokens > 0
      ? formatDetailedUsage(usage, { includesCompactedUsage: true, includesSubagentUsage: true })
      : [["Usage", "No usage recorded yet for this conversation."]],
  );
}

export function showHelp(ctx: SlashContext): void {
  ctx.clearEmptyState();
  ctx.renderInfoMessage(
    "Slash commands",
    visibleCommands().map((command): [string, string] => {
      const argsPart = command.args ? ` ${command.args}` : "";
      return [`/${command.name}${argsPart}`, command.description];
    }),
  );
}
