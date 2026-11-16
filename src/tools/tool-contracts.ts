export const BUILTIN_TOOL_NAMES = [
  "read",
  "vault_inspect",
  "write",
  "edit",
  "rename",
  "delete",
  "set_properties",
] as const;

export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[number];

export type ToolPathKind = "file" | "file-or-folder" | "search-root" | "destination";
export type ToolExecutionMode = "default" | "sequential";
export type ToolPreviewKind = "none" | "diff" | "delete" | "rename";
export type ToolIgnoreBehavior = "target-hidden" | "results-filtered" | "source-and-destination-hidden";

export interface ToolPathArgument {
  name: "path" | "newPath";
  required: boolean;
  kind: ToolPathKind;
}

export interface ToolApprovalContract {
  description: string;
  preview: ToolPreviewKind;
  requiresContent: boolean;
}

export interface BuiltinToolContract {
  name: BuiltinToolName;
  label: string;
  mutating: boolean;
  undoable: boolean;
  pathArgs: readonly ToolPathArgument[];
  ignoreBehavior: ToolIgnoreBehavior;
  approval: ToolApprovalContract;
  executionMode: ToolExecutionMode;
}

const TARGET_FILE: readonly ToolPathArgument[] = [{ name: "path", required: true, kind: "file" }];
const TARGET_FILE_OR_FOLDER: readonly ToolPathArgument[] = [{ name: "path", required: true, kind: "file-or-folder" }];
const OPTIONAL_SEARCH_ROOT: readonly ToolPathArgument[] = [{ name: "path", required: false, kind: "search-root" }];
const RENAME_PATHS: readonly ToolPathArgument[] = [
  { name: "path", required: true, kind: "file" },
  { name: "newPath", required: true, kind: "destination" },
];

export const BUILTIN_TOOL_CONTRACTS: readonly BuiltinToolContract[] = [
  {
    name: "read",
    label: "Read file",
    mutating: false,
    undoable: false,
    pathArgs: TARGET_FILE,
    ignoreBehavior: "target-hidden",
    approval: {
      description: "The agent wants to read a vault file. Review the path before allowing it.",
      preview: "none",
      requiresContent: false,
    },
    executionMode: "default",
  },
  {
    name: "vault_inspect",
    label: "Inspect vault",
    mutating: false,
    undoable: false,
    pathArgs: OPTIONAL_SEARCH_ROOT,
    ignoreBehavior: "results-filtered",
    approval: {
      description: "The agent wants to inspect vault context. Review the target or query before allowing it.",
      preview: "none",
      requiresContent: false,
    },
    executionMode: "default",
  },
  {
    name: "write",
    label: "Write file",
    mutating: true,
    undoable: true,
    pathArgs: TARGET_FILE,
    ignoreBehavior: "target-hidden",
    approval: {
      description: "The agent wants to create or overwrite a vault file. Review the change before allowing it.",
      preview: "diff",
      requiresContent: true,
    },
    executionMode: "sequential",
  },
  {
    name: "edit",
    label: "Edit file",
    mutating: true,
    undoable: true,
    pathArgs: TARGET_FILE,
    ignoreBehavior: "target-hidden",
    approval: {
      description: "The agent wants to edit a vault file. Review the diff before allowing it.",
      preview: "diff",
      requiresContent: true,
    },
    executionMode: "sequential",
  },
  {
    name: "rename",
    label: "Rename or move file",
    mutating: true,
    undoable: true,
    pathArgs: RENAME_PATHS,
    ignoreBehavior: "source-and-destination-hidden",
    approval: {
      description: "The agent wants to rename or move a vault file. Review the source and destination before allowing it.",
      preview: "rename",
      requiresContent: false,
    },
    executionMode: "sequential",
  },
  {
    name: "delete",
    label: "Delete file or folder",
    mutating: true,
    undoable: true,
    pathArgs: TARGET_FILE_OR_FOLDER,
    ignoreBehavior: "target-hidden",
    approval: {
      description: "The agent wants to move a vault file or folder to trash. Non-empty folders need recursive:true, which always asks (even in YOLO) unless deletes are explicitly per-tool allowed — otherwise ask back first. Rare adapter fallback may bypass trash when system trash is unavailable. Review the deletion before allowing it.",
      preview: "delete",
      requiresContent: true,
    },
    executionMode: "sequential",
  },
  {
    name: "set_properties",
    label: "Set note properties",
    mutating: true,
    undoable: true,
    pathArgs: TARGET_FILE,
    ignoreBehavior: "target-hidden",
    approval: {
      description: "The agent wants to update note properties. Review the requested property changes before allowing it.",
      preview: "none",
      requiresContent: false,
    },
    executionMode: "sequential",
  },
];

const CONTRACT_BY_NAME = new Map<string, BuiltinToolContract>(
  BUILTIN_TOOL_CONTRACTS.map((contract) => [contract.name, contract]),
);

export const MUTATING_TOOLS: ReadonlySet<string> = new Set(
  BUILTIN_TOOL_CONTRACTS.filter((contract) => contract.mutating).map((contract) => contract.name),
);

export const UNDOABLE_TOOLS: ReadonlySet<string> = new Set(
  BUILTIN_TOOL_CONTRACTS.filter((contract) => contract.undoable).map((contract) => contract.name),
);

export function getBuiltinToolContract(name: string): BuiltinToolContract | undefined {
  return CONTRACT_BY_NAME.get(name);
}

export function builtinToolContract(name: BuiltinToolName): BuiltinToolContract {
  const contract = getBuiltinToolContract(name);
  if (!contract) throw new Error(`Missing built-in tool contract: ${name}`);
  return contract;
}

export function builtinToolLabel(name: BuiltinToolName): string {
  return builtinToolContract(name).label;
}

export function builtinToolExecutionMode(name: BuiltinToolName): "sequential" | undefined {
  return builtinToolContract(name).executionMode === "sequential" ? "sequential" : undefined;
}

export function approvalPreviewNeedsContent(name: string): boolean {
  return getBuiltinToolContract(name)?.approval.requiresContent ?? false;
}

export function toolApprovalDescription(name: string): string {
  const contract = getBuiltinToolContract(name);
  if (contract) return contract.approval.description;
  if (name === "create_skill") {
    return (
      "The agent wants to create a persistent skill package (writes plugin.json + skills/<name>/SKILL.md " +
      "under the plugins folder). The package persists across sessions and cannot be undone with /undo. " +
      "YOLO does not auto-approve this — review the full body before allowing it."
    );
  }
  return `The agent wants to run the ${name} tool. Review the arguments before allowing it.`;
}
