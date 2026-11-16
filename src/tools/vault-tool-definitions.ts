import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import {
  BUILTIN_TOOL_NAMES,
  builtinToolExecutionMode,
  builtinToolLabel,
  type BuiltinToolName,
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
  rename: typeof RenameParameters;
  delete: typeof DeleteParameters;
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
    "Ignored paths stay hidden.",
  write:
    "Create or overwrite a vault file; parent folders are auto-created. " +
    "For frontmatter-only changes, prefer set_properties.",
  edit:
    "Apply exact text replacements to a vault file. Each oldText must match exactly once.",
  rename: "Rename or move a vault file; wikilinks and backlinks update automatically.",
  delete:
    "Move a vault file or folder to trash. recursive:true empties folders, only on plain request.",
  set_properties:
    "Merge keys into a note's YAML frontmatter (set/overwrite; pass null to delete a key). " +
    "Edits structured frontmatter, never raw YAML text.",
};

const VAULT_TOOL_PARAMETERS: VaultToolParameterSchemaByName = {
  read: ReadParameters,
  vault_inspect: VaultInspectParameters,
  write: WriteParameters,
  edit: EditParameters,
  rename: RenameParameters,
  delete: DeleteParameters,
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

export function vaultToolDefinitions(): VaultToolDefinition[] {
  return BUILTIN_TOOL_NAMES.map((name) => vaultToolDefinition(name));
}
