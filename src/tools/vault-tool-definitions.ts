import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import {
  builtinToolContractsForSurface,
  builtinToolExecutionMode,
  builtinToolLabel,
  type BuiltinToolName,
  type BuiltinToolSurface,
} from "./tool-contracts";

export const ReadParameters = Type.Object({
  path: Type.String({ description: "vault-relative path" }),
  startLine: Type.Optional(Type.Number({ description: "first line, 1-based (alias of offset)" })),
  endLine: Type.Optional(Type.Number({ description: "last line, 1-based inclusive" })),
  offset: Type.Optional(Type.Number({ description: "start line, 1-based" })),
  limit: Type.Optional(Type.Number({ description: "max lines" })),
});

export const VaultInspectParameters = Type.Object({
  action: Type.String({
    description: "list|search|active_note|local_graph|properties",
  }),
  path: Type.Optional(Type.String({ description: "target path" })),
  query: Type.Optional(Type.String({ description: "search text" })),
  kind: Type.Optional(Type.String({ description: "both|files|content" })),
  includeContent: Type.Optional(Type.Boolean({ description: "include note text" })),
  includeSelection: Type.Optional(Type.Boolean({ description: "include selected text" })),
  caseSensitive: Type.Optional(Type.Boolean({ description: "case-sensitive" })),
  regex: Type.Optional(Type.Boolean({ description: "treat query as regex" })),
  maxResults: Type.Optional(Type.Number({ description: "max filename matches" })),
  maxMatches: Type.Optional(Type.Number({ description: "max content matches" })),
});

export const WriteParameters = Type.Object({
  path: Type.String({ description: "vault-relative path" }),
  content: Type.String({ description: "full file content" }),
});

export const EditParameters = Type.Object({
  path: Type.String({ description: "vault-relative path" }),
  edits: Type.Array(
    Type.Object({
      oldText: Type.String({ description: "exact text to replace (must occur exactly once)" }),
      newText: Type.String({ description: "replacement text" }),
    }),
    { description: "exact replacements, applied in one pass" },
  ),
});

export const LsParameters = Type.Object({
  path: Type.Optional(Type.String({ description: "folder path; empty = vault root" })),
});

export const FindParameters = Type.Object({
  pattern: Type.String({ description: "case-insensitive substring or * / ? glob" }),
  maxResults: Type.Optional(Type.Number()),
});

export const GrepParameters = Type.Object({
  pattern: Type.String({ description: "text or regex to find" }),
  path: Type.Optional(Type.String({ description: "restrict to folder" })),
  caseSensitive: Type.Optional(Type.Boolean()),
  regex: Type.Optional(Type.Boolean({ description: "treat pattern as regex" })),
  maxMatches: Type.Optional(Type.Number()),
});

export const SearchParameters = Type.Object({
  query: Type.String({ description: "filename or text to find" }),
  kind: Type.Optional(Type.String({ description: "both|files|content" })),
  path: Type.Optional(Type.String({ description: "restrict to folder" })),
  caseSensitive: Type.Optional(Type.Boolean()),
  regex: Type.Optional(Type.Boolean({ description: "treat query as regex" })),
  maxResults: Type.Optional(Type.Number({ description: "max filename matches" })),
  maxMatches: Type.Optional(Type.Number({ description: "max content matches" })),
});

export const ActiveNoteParameters = Type.Object({
  includeContent: Type.Optional(Type.Boolean({ description: "include note text" })),
  includeSelection: Type.Optional(Type.Boolean({ description: "include selection" })),
});

export const RenameParameters = Type.Object({
  path: Type.String({ description: "current path" }),
  newPath: Type.String({ description: "new path; links update automatically" }),
});

export const DeleteParameters = Type.Object({
  path: Type.String({ description: "path to trash" }),
  recursive: Type.Optional(
    Type.Boolean({
      description: "Folder contents too. Only on plain request.",
    }),
  ),
});

export const BacklinksParameters = Type.Object({
  path: Type.String({ description: "note to find inbound links to" }),
});

export const LinksParameters = Type.Object({
  path: Type.String({ description: "note whose outbound links to list" }),
});

export const LocalGraphParameters = Type.Object({
  path: Type.String({ description: "note whose neighborhood to map" }),
});

export const GetPropertiesParameters = Type.Object({
  path: Type.String({ description: "note whose frontmatter to read" }),
});

export const SetPropertiesParameters = Type.Object({
  path: Type.String({ description: "note whose frontmatter to update" }),
  properties: Type.Record(Type.String(), Type.Unknown(), {
    description: "key/value pairs to merge; null deletes the key",
  }),
});

type VaultToolParameterSchemaByName = {
  read: typeof ReadParameters;
  vault_inspect: typeof VaultInspectParameters;
  write: typeof WriteParameters;
  edit: typeof EditParameters;
  ls: typeof LsParameters;
  search: typeof SearchParameters;
  find: typeof FindParameters;
  grep: typeof GrepParameters;
  get_active_note: typeof ActiveNoteParameters;
  rename: typeof RenameParameters;
  delete: typeof DeleteParameters;
  get_backlinks: typeof BacklinksParameters;
  get_links: typeof LinksParameters;
  local_graph: typeof LocalGraphParameters;
  get_properties: typeof GetPropertiesParameters;
  set_properties: typeof SetPropertiesParameters;
};

export type VaultToolDefinition<Name extends BuiltinToolName = BuiltinToolName> =
  Name extends BuiltinToolName
    ? Pick<AgentTool<VaultToolParameterSchemaByName[Name]>, "label" | "description" | "parameters" | "executionMode"> & {
        name: Name;
      }
    : never;

const VAULT_TOOL_DESCRIPTIONS: Record<BuiltinToolName, string> = {
  read: "Read a vault file. For large files, use startLine/endLine or offset/limit ranges.",
  vault_inspect:
    "Read-only vault inspection: list folders, search names/content, inspect the active note, map links, read frontmatter. " +
    "Ignored paths stay hidden; working-directory approval still applies.",
  write:
    "Create or overwrite a vault file; parent folders are auto-created. " +
    "For frontmatter-only changes, prefer set_properties.",
  edit:
    "Apply exact text replacements to a vault file. Each oldText must match exactly once.",
  ls: "List files and folders in a vault folder.",
  search:
    "Search vault file names and text in one tool. kind: both, files, or content.",
  find: "Find vault files by substring or * / ? glob.",
  grep: "Search vault file text. Literal by default; set regex to treat the pattern as a regular expression.",
  get_active_note:
    "Return the active note path and optional text/selection. Use when the user says 'this note'.",
  rename: "Rename or move a vault file; wikilinks and backlinks update automatically.",
  delete:
    "Move a vault file or folder to trash. recursive:true empties folders, only on plain request.",
  get_backlinks: "List notes that link TO a note (inbound wikilinks).",
  get_links: "List the notes a note links TO (outbound resolved links).",
  local_graph: "Show a note's inbound and outbound link neighborhood.",
  get_properties: "Read a note's YAML frontmatter as structured data.",
  set_properties:
    "Merge keys into a note's YAML frontmatter (set/overwrite; pass null to delete a key). " +
    "Edits structured frontmatter, never raw YAML text.",
};

const VAULT_TOOL_PARAMETERS: VaultToolParameterSchemaByName = {
  read: ReadParameters,
  vault_inspect: VaultInspectParameters,
  write: WriteParameters,
  edit: EditParameters,
  ls: LsParameters,
  search: SearchParameters,
  find: FindParameters,
  grep: GrepParameters,
  get_active_note: ActiveNoteParameters,
  rename: RenameParameters,
  delete: DeleteParameters,
  get_backlinks: BacklinksParameters,
  get_links: LinksParameters,
  local_graph: LocalGraphParameters,
  get_properties: GetPropertiesParameters,
  set_properties: SetPropertiesParameters,
};

export function vaultToolDefinition<Name extends BuiltinToolName>(name: Name): VaultToolDefinition<Name> {
  return {
    name,
    label: builtinToolLabel(name),
    description: VAULT_TOOL_DESCRIPTIONS[name],
    parameters: VAULT_TOOL_PARAMETERS[name],
    executionMode: builtinToolExecutionMode(name),
  } as VaultToolDefinition<Name>;
}

export function vaultToolDefinitionsForSurface(surface?: BuiltinToolSurface): VaultToolDefinition[] {
  return builtinToolContractsForSurface(surface).map((contract) => vaultToolDefinition(contract.name));
}
