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
  path: Type.String({ description: "Vault-relative path to the file, including extension" }),
  startLine: Type.Optional(Type.Number({ description: "1-based first line to read. Alias for offset." })),
  endLine: Type.Optional(Type.Number({ description: "1-based last line to read, inclusive." })),
  offset: Type.Optional(Type.Number({ description: "1-based line to start reading from" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

export const VaultInspectParameters = Type.Object({
  action: Type.String({
    description: "One of: list, search, active_note, local_graph, properties.",
  }),
  path: Type.Optional(Type.String({ description: "Vault-relative file/folder path when the action needs a target." })),
  query: Type.Optional(Type.String({ description: "Search query for action=search." })),
  kind: Type.Optional(Type.String({ description: "For action=search: both, files, or content. Defaults to both." })),
  includeContent: Type.Optional(Type.Boolean({ description: "For action=active_note: include note text." })),
  includeSelection: Type.Optional(Type.Boolean({ description: "For action=active_note: include selected text." })),
  caseSensitive: Type.Optional(Type.Boolean({ description: "For action=search." })),
  regex: Type.Optional(Type.Boolean({ description: "For action=search: treat query as a regular expression." })),
  maxResults: Type.Optional(Type.Number({ description: "For action=search: maximum file-name matches." })),
  maxMatches: Type.Optional(Type.Number({ description: "For action=search: maximum content matches." })),
});

export const WriteParameters = Type.Object({
  path: Type.String({ description: "Vault-relative path, e.g. Folder/Note.md" }),
  content: Type.String({ description: "Full file content to write" }),
});

export const EditParameters = Type.Object({
  path: Type.String({ description: "Vault-relative path to the file to edit" }),
  edits: Type.Array(
    Type.Object({
      oldText: Type.String({ description: "Exact text to replace (must occur exactly once)" }),
      newText: Type.String({ description: "Replacement text" }),
    }),
    { description: "One or more exact replacements applied in a single pass" },
  ),
});

export const LsParameters = Type.Object({
  path: Type.Optional(Type.String({ description: "Vault-relative folder path; empty for the vault root" })),
});

export const FindParameters = Type.Object({
  pattern: Type.String({ description: "Case-insensitive substring or simple * and ? glob" }),
  maxResults: Type.Optional(Type.Number()),
});

export const GrepParameters = Type.Object({
  pattern: Type.String({ description: "Text or regex to search for in file contents" }),
  path: Type.Optional(Type.String({ description: "Restrict search to this vault-relative folder" })),
  caseSensitive: Type.Optional(Type.Boolean()),
  regex: Type.Optional(Type.Boolean({ description: "Treat pattern as a regular expression" })),
  maxMatches: Type.Optional(Type.Number()),
});

export const SearchParameters = Type.Object({
  query: Type.String({ description: "Filename or file text to search for" }),
  kind: Type.Optional(Type.String({ description: "One of: both, files, content. Defaults to both." })),
  path: Type.Optional(Type.String({ description: "Restrict search to this vault-relative folder" })),
  caseSensitive: Type.Optional(Type.Boolean()),
  regex: Type.Optional(Type.Boolean({ description: "Treat the content query as a regular expression" })),
  maxResults: Type.Optional(Type.Number({ description: "Maximum file-name matches to return" })),
  maxMatches: Type.Optional(Type.Number({ description: "Maximum content matches to return" })),
});

export const ActiveNoteParameters = Type.Object({
  includeContent: Type.Optional(Type.Boolean({ description: "Include the note's text" })),
  includeSelection: Type.Optional(Type.Boolean({ description: "Include the current editor selection" })),
});

export const RenameParameters = Type.Object({
  path: Type.String({ description: "Current vault-relative path" }),
  newPath: Type.String({ description: "New vault-relative path; backlinks are updated automatically" }),
});

export const DeleteParameters = Type.Object({
  path: Type.String({ description: "Vault-relative path to move to trash" }),
});

export const BacklinksParameters = Type.Object({
  path: Type.String({ description: "Vault-relative path of the note to find inbound links to" }),
});

export const LinksParameters = Type.Object({
  path: Type.String({ description: "Vault-relative path of the note whose outbound links to list" }),
});

export const LocalGraphParameters = Type.Object({
  path: Type.String({ description: "Vault-relative path of the note to map the neighborhood of" }),
});

export const GetPropertiesParameters = Type.Object({
  path: Type.String({ description: "Vault-relative path of the note whose frontmatter to read" }),
});

export const SetPropertiesParameters = Type.Object({
  path: Type.String({ description: "Vault-relative path of the note whose frontmatter to update" }),
  properties: Type.Record(Type.String(), Type.Unknown(), {
    description:
      "Key/value pairs to merge into the note's YAML frontmatter. Existing keys are overwritten; " +
      "keys not listed are left untouched. Pass null as a value to delete that key.",
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
  read:
    "Read a vault-relative Markdown/text file. For large files or focused questions, prefer a range with startLine/endLine or offset/limit.",
  vault_inspect:
    "Read-only meta-tool for vault context. Use action=list, search, active_note, local_graph, or properties. " +
    "Ignored paths remain hidden and working-directory approval still applies to path/pathless calls.",
  write:
    "Create or overwrite a vault-relative file. Parent folders are created as needed. " +
    "For frontmatter-only changes, prefer set_properties.",
  edit:
    "Apply exact text replacements to a vault-relative file. Each oldText must match exactly once.",
  ls: "List files and folders at a vault-relative folder path.",
  search:
    "Search vault file names and file contents with one tool. Use kind=files for path discovery, " +
    "kind=content for text search, or kind=both when unsure.",
  find: "Find vault files by case-insensitive substring or simple * and ? glob pattern.",
  grep: "Search text files in the vault. Literal by default; set regex true for regular expressions.",
  get_active_note:
    "Return the active note path, with optional selected text and content. Use when the user says 'this note'.",
  rename: "Rename or move a vault file. Wikilinks and backlinks are updated automatically.",
  delete: "Move a vault file or empty folder to trash (recoverable).",
  get_backlinks: "List notes that link TO a given note (inbound wikilinks).",
  get_links: "List the notes a given note links TO (outbound resolved links).",
  local_graph: "Show a note's immediate neighborhood: inbound (backlinks) and outbound (resolved links) notes.",
  get_properties: "Read a note's YAML frontmatter as structured key/value data.",
  set_properties:
    "Merge keys into a note's YAML frontmatter (set/overwrite; pass null to delete a key). " +
    "Edits the structured frontmatter, never the raw YAML text.",
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
    parameters: VAULT_TOOL_PARAMETERS[name] as VaultToolParameterSchemaByName[Name],
    executionMode: builtinToolExecutionMode(name),
  } as VaultToolDefinition<Name>;
}

export function vaultToolDefinitionsForSurface(surface?: BuiltinToolSurface): VaultToolDefinition[] {
  return builtinToolContractsForSurface(surface).map((contract) => vaultToolDefinition(contract.name));
}
