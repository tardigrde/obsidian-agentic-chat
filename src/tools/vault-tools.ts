import type { App } from "obsidian";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { IgnoreMatcher } from "../vault/ignore";
import type { ReadMemo } from "../vault/read-memo";
import {
  builtinToolContractsForSurface,
  type BuiltinToolName,
  type BuiltinToolSurface,
} from "./tool-contracts";
import { createActiveNoteTool, createLsTool, createReadTool, createVaultInspectTool } from "./vault/read-tools";
import { createFindTool, createGrepTool, createSearchTool } from "./vault/search-tools";
import { createDeleteTool, createEditTool, createRenameTool, createWriteTool } from "./vault/write-tools";
import {
  createBacklinksTool,
  createGetPropertiesTool,
  createLinksTool,
  createLocalGraphTool,
  createSetPropertiesTool,
} from "./vault/graph-tools";
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
export interface CreateVaultToolsOptions {
  surface?: BuiltinToolSurface;
}

export function createVaultTools(
  app: App,
  isIgnored: IgnoreMatcher = () => false,
  memo?: ReadMemo,
  options: CreateVaultToolsOptions = {},
): AgentTool[] {
  const context: VaultToolFactoryContext = { app, isIgnored, memo };
  return builtinToolContractsForSurface(options.surface).map((contract) => VAULT_TOOL_FACTORIES[contract.name](context));
}

const VAULT_TOOL_FACTORIES: Record<BuiltinToolName, (context: VaultToolFactoryContext) => AgentTool> = {
  read: ({ app, isIgnored, memo }) => createReadTool(app, isIgnored, memo),
  vault_inspect: ({ app, isIgnored }) => createVaultInspectTool(app, isIgnored),
  write: ({ app, isIgnored, memo }) => createWriteTool(app, isIgnored, memo),
  edit: ({ app, isIgnored, memo }) => createEditTool(app, isIgnored, memo),
  ls: ({ app, isIgnored }) => createLsTool(app, isIgnored),
  search: ({ app, isIgnored }) => createSearchTool(app, isIgnored),
  find: ({ app, isIgnored }) => createFindTool(app, isIgnored),
  grep: ({ app, isIgnored }) => createGrepTool(app, isIgnored),
  get_active_note: ({ app, isIgnored }) => createActiveNoteTool(app, isIgnored),
  rename: ({ app, isIgnored, memo }) => createRenameTool(app, isIgnored, memo),
  delete: ({ app, isIgnored, memo }) => createDeleteTool(app, isIgnored, memo),
  get_backlinks: ({ app, isIgnored }) => createBacklinksTool(app, isIgnored),
  get_links: ({ app, isIgnored }) => createLinksTool(app, isIgnored),
  local_graph: ({ app, isIgnored }) => createLocalGraphTool(app, isIgnored),
  get_properties: ({ app, isIgnored }) => createGetPropertiesTool(app, isIgnored),
  set_properties: ({ app, isIgnored }) => createSetPropertiesTool(app, isIgnored),
};
