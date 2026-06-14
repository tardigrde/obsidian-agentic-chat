import { type App, parseYaml, TFile } from "obsidian";
import type { Skill } from "@earendil-works/pi-agent-core";
import { formatSkillInvocation, parseCommandArgs, substituteArgs } from "@earendil-works/pi-agent-core";
import { normalizeFolderPath } from "../vault/path";

// pi owns the spec-compatible formatting; we only handle loading from the vault.
export {
  formatSkillsForSystemPrompt,
  formatSkillInvocation,
  parseCommandArgs,
  substituteArgs,
} from "@earendil-works/pi-agent-core";

// $1–$9 / $@ / $ARGUMENTS / ${@:N} — the placeholders pi's substituteArgs understands.
// The positional case requires the digit not be followed by another digit, a period, or
// a comma, so currency in a skill body ($10, $1.50, $1,000, "costs $1.") isn't misread as
// a template. When detection is ambiguous we prefer NOT substituting: a literal `$1.` left
// in the output is obvious and fixable, whereas wrongly substituting silently corrupts text.
const ARG_PLACEHOLDER = /\$(?:ARGUMENTS|@|[1-9](?![\d.,])|\{@)/;

/**
 * Build the user-message prompt for invoking a skill, folding in any arguments.
 * If the body contains `$1`/`$ARGUMENTS`-style placeholders, the args are
 * substituted into it (templates are just skills with placeholders). Otherwise
 * the arg string is appended as freeform additional instructions.
 */
export function buildSkillInvocation(skill: Skill, argString?: string): string {
  const trimmed = argString?.trim() ?? "";
  if (!trimmed) return formatSkillInvocation(skill);
  if (ARG_PLACEHOLDER.test(skill.content)) {
    const substituted = substituteArgs(skill.content, parseCommandArgs(trimmed));
    return formatSkillInvocation({ ...skill, content: substituted });
  }
  return formatSkillInvocation(skill, trimmed);
}

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
    let raw: string;
    try {
      raw = await app.vault.cachedRead(file);
    } catch (error) {
      // A single unreadable file (deleted mid-scan, permission issue) must not
      // abort the whole skill load — skip it and keep the rest.
      console.warn(`Agentic chat: could not read skill file ${file.path}`, error);
      continue;
    }
    const { data, body } = splitFrontmatter(raw);
    const name = stringField(data, "name") ?? deriveName(file);
    const description = stringField(data, "description") ?? name;
    if (!body.trim()) continue;
    skills.push({ name, description, content: body, filePath: file.path });
  }
  return dedupeByName(skills);
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
