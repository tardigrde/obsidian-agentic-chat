import { formatPluginAudit, type LoadedPlugin } from "../../plugins/loader";
import { activeModelId } from "../../settings-schema";
import { MODES } from "../../agent/modes";
import { OUTPUT_STYLES } from "../../agent/output-styles";
import {
  formatMcpDiagnosticRows,
  formatMcpDiagnosticSummary,
  formatRuntimeDiagnosticsRows,
  formatToolBudgetDiagnostic,
} from "../../agent/diagnostics";
import { errorMessage } from "../../utils/errors";
import { formatDetailedUsage } from "../format";
import { visibleCommands } from "../commands";
import type { SlashContext } from "./context";

/**
 * `/doctor`: one health panel for everything that matters — an aggregate
 * status line, the agent-plugin audit, then the full runtime diagnostics.
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
  const folder = ctx.plugin.settings.plugins.folder || ".agentic-plugins";
  const pluginAudit =
    plugins.length === 0
      ? `No plugin packages found in ${folder}. Generate one from the MCP settings tab.`
      : formatPluginAudit(plugins);
  const diagnostics = ctx.service.getRuntimeDiagnostics();
  const issues: string[] = [];
  const failedPlugins = plugins.filter((plugin) => plugin.auditStatus === "failed").length;
  if (failedPlugins > 0) issues.push(`${failedPlugins} of ${plugins.length} agent plugin(s) need attention`);
  const failedMcp = diagnostics.resources.mcpServers.filter((server) => server.status === "error").length;
  if (failedMcp > 0) issues.push(`${failedMcp} MCP server(s) failing`);
  if (diagnostics.state.lastError) issues.push("last run ended in an error");
  if (diagnostics.observability.enabled && diagnostics.observability.exportHealth.failedExports > 0) {
    issues.push("observability exports failing");
  }
  ctx.renderInfoMessage("Doctor", [
    ["Status", issues.length === 0 ? "All OK." : `${issues.join("; ")}.`],
    ["Agent plugins", pluginAudit],
    ...formatRuntimeDiagnosticsRows(diagnostics),
  ]);
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
    ["Output style", OUTPUT_STYLES[settings.outputStyle].label],
    // The active level, i.e. the configured level clamped to what the model
    // actually supports — the raw setting alone can overstate the next turn.
    ["Thinking", ctx.service.getActiveThinkingLevel()],
    ["Approval (mutating)", settings.approval.mutating],
    ["Tool budget", formatToolBudgetDiagnostic(diagnostics.toolBudget)],
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
