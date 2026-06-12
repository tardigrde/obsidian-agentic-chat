import { App, TFile, TFolder, normalizePath } from "obsidian";
import { Type } from "typebox";
import { AgentTool, RunContext, defineTool, stringEnum } from "../agent/tool";
import { ModelRetry } from "../agent/errors";

/** Dependencies injected into every vault tool execution. */
export interface VaultDeps {
  app: App;
}

const MAX_NOTE_CHARS = 50_000;
const MAX_SEARCH_RESULTS = 20;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[Truncated: the full content is ${text.length} characters long]`;
}

function resolveNote(app: App, path: string): TFile {
  const file = app.vault.getAbstractFileByPath(normalizePath(path));
  if (!(file instanceof TFile)) {
    throw new ModelRetry(
      `No note found at "${path}". Use list_folder or search_vault to find the correct path.`,
    );
  }
  return file;
}

async function ensureParentFolder(app: App, path: string): Promise<void> {
  const parent = path.split("/").slice(0, -1).join("/");
  if (!parent) return;
  let current = "";
  for (const segment of parent.split("/")) {
    current = current ? `${current}/${segment}` : segment;
    const node = app.vault.getAbstractFileByPath(current);
    if (node instanceof TFolder) continue;
    if (node) throw new ModelRetry(`"${current}" already exists but is not a folder.`);
    await app.vault.createFolder(current);
  }
}

const readNote = defineTool({
  name: "read_note",
  description:
    'Read the full contents of a note in the vault. The path is vault-relative and includes the extension, e.g. "Projects/Ideas.md".',
  parameters: Type.Object({
    path: Type.String({ description: "Vault-relative path to the note, including the file extension" }),
  }),
  execute: async ({ path }, { deps }: RunContext<VaultDeps>) => {
    const file = resolveNote(deps.app, path);
    const content = await deps.app.vault.cachedRead(file);
    return truncate(content, MAX_NOTE_CHARS);
  },
});

const writeNote = defineTool({
  name: "write_note",
  description:
    "Create a new note or modify an existing one. Parent folders are created automatically.",
  parameters: Type.Object({
    path: Type.String({ description: 'Vault-relative path, e.g. "Folder/Note.md"' }),
    content: Type.String({ description: "Markdown content to write" }),
    mode: Type.Optional(
      stringEnum(["create", "overwrite", "append"], {
        default: "create",
        description:
          '"create" fails if the note already exists; "overwrite" replaces its content; "append" adds to the end',
      }),
    ),
  }),
  execute: async ({ path, content, mode = "create" }, { deps }: RunContext<VaultDeps>) => {
    const normalized = normalizePath(path);
    const existing = deps.app.vault.getAbstractFileByPath(normalized);
    if (existing && !(existing instanceof TFile)) {
      throw new ModelRetry(`"${normalized}" exists but is not a note.`);
    }
    if (mode === "create") {
      if (existing) {
        throw new ModelRetry(
          `A note already exists at "${normalized}". Use mode "overwrite" or "append" to modify it.`,
        );
      }
      await ensureParentFolder(deps.app, normalized);
      await deps.app.vault.create(normalized, content);
      return `Created "${normalized}" (${content.length} characters).`;
    }
    if (!existing) {
      await ensureParentFolder(deps.app, normalized);
      await deps.app.vault.create(normalized, content);
      return `Note did not exist yet; created "${normalized}" (${content.length} characters).`;
    }
    if (mode === "overwrite") {
      await deps.app.vault.modify(existing, content);
      return `Overwrote "${normalized}" (${content.length} characters).`;
    }
    await deps.app.vault.append(existing, content.startsWith("\n") ? content : `\n${content}`);
    return `Appended ${content.length} characters to "${normalized}".`;
  },
});

const listFolder = defineTool({
  name: "list_folder",
  description:
    'List the notes and subfolders inside a vault folder. Use "/" for the vault root. Folders are shown with a trailing slash.',
  parameters: Type.Object({
    path: Type.Optional(
      Type.String({ default: "/", description: 'Vault-relative folder path, or "/" for the root' }),
    ),
  }),
  execute: ({ path = "/" }, { deps }: RunContext<VaultDeps>) => {
    const target =
      path === "/" || path === ""
        ? deps.app.vault.getRoot()
        : deps.app.vault.getAbstractFileByPath(normalizePath(path));
    if (!(target instanceof TFolder)) {
      throw new ModelRetry(`No folder found at "${path}". Use "/" to list the vault root.`);
    }
    const lines = [...target.children]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((child) => (child instanceof TFolder ? `${child.name}/` : child.name));
    return lines.length > 0 ? lines.join("\n") : "(empty folder)";
  },
});

const searchVault = defineTool({
  name: "search_vault",
  description:
    "Search all markdown notes for a text query (case-insensitive, matches file paths and contents). Returns matching paths with a snippet.",
  parameters: Type.Object({
    query: Type.String({ minLength: 1, description: "Text to search for" }),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: `Maximum number of results (default 10, max ${MAX_SEARCH_RESULTS})`,
      }),
    ),
  }),
  execute: async ({ query, limit }, { deps }: RunContext<VaultDeps>) => {
    const needle = query.toLowerCase();
    const cap = Math.min(limit ?? 10, MAX_SEARCH_RESULTS);
    const results: string[] = [];
    for (const file of deps.app.vault.getMarkdownFiles()) {
      if (results.length >= cap) break;
      const nameHit = file.path.toLowerCase().includes(needle);
      const content = await deps.app.vault.cachedRead(file);
      const index = content.toLowerCase().indexOf(needle);
      if (!nameHit && index === -1) continue;
      const snippet =
        index === -1
          ? content.slice(0, 160)
          : content.slice(Math.max(0, index - 80), index + needle.length + 80);
      results.push(`${file.path}\n  …${snippet.replace(/\s+/g, " ").trim()}…`);
    }
    return results.length > 0
      ? `Found ${results.length} match(es):\n\n${results.join("\n\n")}`
      : `No notes matched "${query}".`;
  },
});

const getActiveNote = defineTool({
  name: "get_active_note",
  description:
    "Get the path and full contents of the note currently open in the editor. Use this when the user refers to 'this note' or 'the current note'.",
  parameters: Type.Object({}),
  execute: async (_args, { deps }: RunContext<VaultDeps>) => {
    const file = deps.app.workspace.getActiveFile();
    if (!file) return "No note is currently active in the editor.";
    const content = await deps.app.vault.cachedRead(file);
    return `Active note: ${file.path}\n\n${truncate(content, MAX_NOTE_CHARS)}`;
  },
});

/** All built-in vault tools, ready to inject into an Agent. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function vaultTools(): AgentTool<VaultDeps, any>[] {
  return [readNote, writeNote, listFolder, searchVault, getActiveNote];
}

export { readNote, writeNote, listFolder, searchVault, getActiveNote };
