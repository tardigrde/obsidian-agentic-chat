export interface ExternalWorkspacePromptSettings {
  enabled: boolean;
  rootPath: string;
}

export function formatExternalWorkspaceForSystemPrompt(settings: ExternalWorkspacePromptSettings): string {
  if (!settings.enabled || !settings.rootPath.trim()) return "";
  return [
    "## External workspace root",
    "A desktop-only external workspace root is configured. It is not prompt context by itself.",
    "Use `external_inspect` for read-only list/read/search when the user asks about files outside the vault.",
    "For external file reads, use search or startLine/endLine/offset/limit before broad reads when the file is large or the question is focused on a specific part.",
    "Avoid repeating the same external_inspect action/path in a turn. Reuse prior or cached external results unless the user asks to re-check or you need a different range/query.",
    "For cache or consistency checks, one exact repeat is enough; do not keep re-listing or re-reading the same path after a cached result confirms it.",
    "Cite external files as passive `external://relative/path` references, never as Obsidian links or absolute filesystem paths.",
  ].join("\n");
}
