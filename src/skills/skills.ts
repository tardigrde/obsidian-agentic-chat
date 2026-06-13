import { type App, parseYaml, TFile } from "obsidian";
import type { PromptTemplate, Skill } from "@earendil-works/pi-agent-core";
import { normalizeFolderPath } from "../vault/path";

// pi owns the spec-compatible formatting; we only handle loading from the vault.
export {
  formatSkillsForSystemPrompt,
  formatSkillInvocation,
  formatPromptTemplateInvocation,
  parseCommandArgs,
  substituteArgs,
} from "@earendil-works/pi-agent-core";

interface Frontmatter {
  data: Record<string, unknown>;
  body: string;
}

function splitFrontmatter(content: string): Frontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!match) return { data: {}, body: content };
  let data: Record<string, unknown> = {};
  try {
    data = (parseYaml(match[1]) as Record<string, unknown>) ?? {};
  } catch {
    data = {};
  }
  return { data, body: content.slice(match[0].length).trimStart() };
}

function isUnder(path: string, folder: string): boolean {
  return folder === "" || path === folder || path.startsWith(`${folder}/`);
}

function stringField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function deriveName(file: TFile): string {
  // A `SKILL.md` is named after its containing folder; a bare note after itself.
  if (file.name.toLowerCase() === "skill.md") {
    return file.parent && file.parent.path ? file.parent.name : file.basename;
  }
  return file.basename;
}

/**
 * Load skills from a vault folder. Picks up any `SKILL.md` under the folder and
 * direct Markdown children, parsing optional `name`/`description` frontmatter.
 * Personas are just skills whose body sets the agent's behaviour.
 */
export async function loadVaultSkills(app: App, folderInput: string): Promise<Skill[]> {
  const folder = safeFolder(folderInput);
  if (folder === null) return [];

  const files = app.vault.getMarkdownFiles().filter((file) => {
    if (!isUnder(file.path, folder)) return false;
    if (file.name.toLowerCase() === "skill.md") return true;
    return (file.parent?.path ?? "") === folder;
  });

  const skills: Skill[] = [];
  for (const file of files.sort((a, b) => a.path.localeCompare(b.path))) {
    const { data, body } = splitFrontmatter(await app.vault.cachedRead(file));
    const name = stringField(data, "name") ?? deriveName(file);
    const description = stringField(data, "description") ?? name;
    if (!body.trim()) continue;
    skills.push({ name, description, content: body, filePath: file.path });
  }
  return dedupeByName(skills);
}

/** Load reusable prompt templates ($ARGUMENTS-aware) from a vault folder. */
export async function loadVaultPromptTemplates(app: App, folderInput: string): Promise<PromptTemplate[]> {
  const folder = safeFolder(folderInput);
  if (folder === null) return [];

  const files = app.vault
    .getMarkdownFiles()
    .filter((file) => (file.parent?.path ?? "") === folder)
    .sort((a, b) => a.path.localeCompare(b.path));

  const templates: PromptTemplate[] = [];
  for (const file of files) {
    const { data, body } = splitFrontmatter(await app.vault.cachedRead(file));
    if (!body.trim()) continue;
    templates.push({
      name: stringField(data, "name") ?? file.basename,
      description: stringField(data, "description"),
      content: body,
    });
  }
  return dedupeByName(templates);
}

function safeFolder(folderInput: string): string | null {
  if (!folderInput.trim()) return null;
  try {
    return normalizeFolderPath(folderInput);
  } catch {
    return null;
  }
}

function dedupeByName<T extends { name: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.name)) return false;
    seen.add(item.name);
    return true;
  });
}
