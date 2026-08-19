import { type App, TFile } from "obsidian";
import { splitFrontmatter, stringField } from "../../skills/skills";
import { normalizeFolderPath } from "../../vault/path";

export interface LegacySkillDoc {
  name: string;
  description: string;
  body: string;
  source: string;
}

/**
 * Replicates the pre-plugins vault skill loader (removed from runtime-resources
 * in the Agent Plugins migration) so users who configured `skillsFolder` or
 * `templatesFolder` keep their skills: a folder's `SKILL.md` files at any depth
 * and direct Markdown children are collected exactly as before.
 */
export async function collectLegacyVaultSkills(
  app: App,
  folders: string[],
): Promise<LegacySkillDoc[]> {
  const all = app.vault.getMarkdownFiles();
  const seen = new Set<string>();
  const out: LegacySkillDoc[] = [];
  for (const folderInput of folders) {
    let folder: string;
    try {
      folder = normalizeFolderPath(folderInput);
    } catch {
      continue;
    }
    if (!folder) continue;
    const files = all.filter((file) => {
      if (!isUnder(file.path, folder)) return false;
      if (file.name.toLowerCase() === "skill.md") return true;
      return (file.parent?.path ?? "") === folder;
    });
    for (const file of files.sort((a, b) => a.path.localeCompare(b.path))) {
      const raw = await app.vault.cachedRead(file);
      const { data, body } = splitFrontmatter(raw);
      const name = stringField(data, "name") ?? deriveName(file);
      const description = stringField(data, "description") ?? name;
      if (!body.trim()) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ name, description, body, source: file.path });
    }
  }
  return out;
}

function isUnder(path: string, folder: string): boolean {
  return folder === "" || path === folder || path.startsWith(`${folder}/`);
}

function deriveName(file: TFile): string {
  if (file.name.toLowerCase() === "skill.md") {
    return file.parent && file.parent.path ? file.parent.name : file.basename;
  }
  return file.basename;
}
