import type { App } from "obsidian";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { IgnoreMatcher } from "../vault/ignore";
import type { ReadMemo } from "../vault/read-memo";
import { BUILTIN_TOOL_NAMES, type BuiltinToolName } from "./tool-contracts";
import { createReadTool, createVaultInspectTool } from "./vault/read-tools";
import { createDeleteTool, createEditTool, createRenameTool, createWriteTool } from "./vault/write-tools";
import { createSetPropertiesTool } from "./vault/graph-tools";
import type { VaultToolFactoryContext } from "./vault/shared";

export { MUTATING_TOOLS } from "./tool-contracts";
export { TEXT_EXTENSIONS } from "./vault/shared";

/**
 * All built-in vault tools, bound to the active Obsidian app.
 *
 * `isIgnored` makes paths invisible to the agent: ignored files cannot be read,
 * listed, searched, or mutated, and report as "not found" so the model cannot
 * even infer their existence. Defaults to a permit-all matcher.
 */
export function createVaultTools(app: App, isIgnored: IgnoreMatcher = () => false, memo?: ReadMemo): AgentTool[] {
  const context: VaultToolFactoryContext = { app, isIgnored, memo };
  return BUILTIN_TOOL_NAMES.map((name) => VAULT_TOOL_FACTORIES[name](context));
}

const VAULT_TOOL_FACTORIES: Record<BuiltinToolName, (context: VaultToolFactoryContext) => AgentTool> = {
  read: ({ app, isIgnored, memo }) => createReadTool(app, isIgnored, memo),
  vault_inspect: ({ app, isIgnored }) => createVaultInspectTool(app, isIgnored),
  write: ({ app, isIgnored, memo }) => createWriteTool(app, isIgnored, memo),
  edit: ({ app, isIgnored, memo }) => createEditTool(app, isIgnored, memo),
  rename: ({ app, isIgnored, memo }) => createRenameTool(app, isIgnored, memo),
  delete: ({ app, isIgnored, memo }) => createDeleteTool(app, isIgnored, memo),
  set_properties: ({ app, isIgnored }) => createSetPropertiesTool(app, isIgnored),
};
