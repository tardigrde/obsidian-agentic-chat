import { BUILTIN_TOOL_NAMES, MUTATING_TOOLS, builtinToolContract } from "./tool-contracts";

/** One row per built-in tool the agent can call. */
export interface ToolCatalogEntry {
  name: string;
  label: string;
  /** True when the tool changes the vault (or writes a downloaded file into it). */
  mutating: boolean;
}

/** Labels owned by their tool definitions; the vault labels come from the contracts. */
const EXTRA_TOOLS: ReadonlyArray<Pick<ToolCatalogEntry, "name" | "label">> = [
  { name: "download_file", label: "Download file" },
  { name: "web_search", label: "Web search" },
  { name: "fetch_url", label: "Fetch web page" },
  { name: "import_document", label: "Import document" },
  { name: "artifact", label: "Artifact" },
  { name: "skill", label: "Skill" },
  { name: "subagent", label: "Dispatch subagent" },
  { name: "ask_user", label: "Ask user" },
  { name: "current_time", label: "Current time" },
  { name: "search_tools", label: "Search tools" },
];

/**
 * The one list of built-in tools. Settings builds one approval row per entry,
 * and a test compares it with the real parent tool build so a new registered
 * tool cannot ship without a row.
 */
export const TOOL_CATALOG: readonly ToolCatalogEntry[] = Object.freeze([
  ...BUILTIN_TOOL_NAMES.map((name) => {
    const contract = builtinToolContract(name);
    return Object.freeze({ name: contract.name, label: contract.label, mutating: contract.mutating });
  }),
  ...EXTRA_TOOLS.map((tool) => Object.freeze({ ...tool, mutating: MUTATING_TOOLS.has(tool.name) })),
]);
