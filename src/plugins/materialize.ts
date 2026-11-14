import { BUILTIN_SKILL_DOCS } from "../skills/builtin-skills";
import { ensureVaultFolder } from "../vault/storage";
import type { ConvertedPackage } from "./import/convert";
import { scaffoldManifest } from "./import/install";
import { collectLegacyVaultSkills } from "./import/migrate-legacy-skills";
import { AGENT_PLUGINS_MCP_SCHEMA_ID, AGENT_PLUGINS_SCHEMA_ID, USER_SKILLS_PACKAGE, slugifyPluginName, validatePluginName } from "./manifest";
import type { PluginVault } from "./plugin-vault";

/**
 * Packages the plugin writes itself: the shipped built-in skills, the user's
 * empty `my-skills` collection, the one-time legacy-skills migration, a
 * single-server MCP package, and a scaffolded skill. Each returns what it
 * wrote; the catalog owner invalidates.
 */

/** Body cap for scaffolded skills (agent path has no modal textarea limit). */
const MAX_SKILL_BODY_CHARS = 64 * 1024;

/**
 * Materialize the `builtins` package (the plugin's own skills as a real,
 * inspectable Agent Plugins package). Only when absent: never overwrites
 * user edits.
 */
export async function materializeBuiltins(vault: PluginVault): Promise<boolean> {
  const writer = vault.writer();
  const target = `${vault.folder()}/builtins`;
  if (await writer.folderExists(target)) return false;
  await writer.ensureFolder(`${target}/skills`);
  for (const skill of BUILTIN_SKILL_DOCS) {
    await writer.writeFile(`${target}/skills/${skill.name}/SKILL.md`, new TextEncoder().encode(skill.doc));
  }
  await writer.writeFile(
    `${target}/plugin.json`,
    scaffoldManifest(
      "builtins",
      "Built-in skills of the Agentic Chat plugin, materialized as an editable Agent Plugins package.",
    ),
  );
  await writer.writeFile(
    `${target}/README.md`,
    "This package holds the plugin's built-in skills as a real Agent Plugins package. " +
      "Edit the SKILL.md files here to customize them; the package is only (re)created when it is missing. " +
      "Use **Repair built-ins** in the Resources tab to restore the originals.\n",
  );
  return true;
}

/** Delete the `builtins` package so the next materialization rewrites it. */
export async function removeBuiltins(vault: PluginVault): Promise<void> {
  await vault.writer().removeFolder(`${vault.folder()}/builtins`);
}

/**
 * Materialize the user's own `my-skills` collection package. Ships empty
 * (manifest + README, no skills/, no mcp.json); both are optional under
 * Agent Plugins §6.2. Only creates missing files, never overwrites user
 * content, and self-heals a half-written package.
 */
export async function materializeMySkills(vault: PluginVault): Promise<boolean> {
  const writer = vault.writer();
  const target = `${vault.folder()}/${USER_SKILLS_PACKAGE}`;
  await writer.ensureFolder(target);
  let created = false;
  if (!(await vault.fileExists(`${target}/plugin.json`))) {
    await writer.writeFile(
      `${target}/plugin.json`,
      scaffoldManifest(
        USER_SKILLS_PACKAGE,
        "Your personal skill collection. Add skills here as skills/<name>/SKILL.md; this package is never overwritten.",
      ),
    );
    created = true;
  }
  if (!(await vault.fileExists(`${target}/README.md`))) {
    await writer.writeFile(
      `${target}/README.md`,
      "This is your personal skill collection. Each `skills/<name>/SKILL.md` you add here becomes " +
        "an agent skill (the skill `name` frontmatter must match its folder name). " +
        "The plugin only creates this package when it is missing and never overwrites your edits.\n",
    );
    created = true;
  }
  return created;
}

/**
 * One-time upgrade migration: materialize legacy `skillsFolder` /
 * `templatesFolder` vault skills into a real `legacy-skills` package. Only when
 * the package is absent; false when there is nothing to preserve.
 */
export async function materializeLegacySkills(vault: PluginVault, folders: string[]): Promise<boolean> {
  const writer = vault.writer();
  const target = `${vault.folder()}/legacy-skills`;
  if (await writer.folderExists(target)) return false;
  const skills = await collectLegacyVaultSkills(vault.app, folders);
  if (skills.length === 0) return false;

  const files: Map<string, Uint8Array> = new Map();
  const usedDirs = new Set<string>();
  for (const skill of skills) {
    const dir = uniqueSkillDir(slugifyPluginName(skill.name) || "skill", usedDirs);
    usedDirs.add(dir);
    const description = skill.description.trim() || `${dir} skill.`;
    const doc = `---\nname: ${JSON.stringify(dir)}\ndescription: ${JSON.stringify(description)}\n---\n\n${skill.body.trim()}\n`;
    files.set(`skills/${dir}/SKILL.md`, new TextEncoder().encode(doc));
  }

  await writer.ensureFolder(`${target}/skills`);
  for (const [rel, bytes] of files) {
    await writer.writeFile(`${target}/${rel}`, bytes);
  }
  await writer.writeFile(
    `${target}/plugin.json`,
    scaffoldManifest(
      "legacy-skills",
      "Skills from the vault skills/templates folders, migrated when Agent Plugins became the single source of truth.",
    ),
  );
  await writer.writeFile(
    `${target}/README.md`,
    "This package holds the skills that used to live in the settings' Skills folder / Prompt templates folder. " +
      "Edit or remove it freely; the migration only creates it once and never overwrites your edits.\n",
  );
  return true;
}

export interface McpServerPackage {
  rootPath: string;
  pluginName: string;
  serverKey: string;
}

/** Write a real Agent Plugins package (plugin.json + mcp.json) for one remote MCP server. */
export async function writeMcpServerPackage(
  vault: PluginVault,
  input: { serverName: string; serverKey: string; url: string },
): Promise<McpServerPackage> {
  const pluginName = vault.nextAvailableName(input.serverName);
  const rootPath = `${vault.folder()}/${pluginName}`;
  await ensureVaultFolder(vault.app, rootPath);
  await vault.app.vault.create(
    `${rootPath}/plugin.json`,
    `${JSON.stringify(
      {
        $schema: AGENT_PLUGINS_SCHEMA_ID,
        name: pluginName,
        version: "1.0.0",
        description: `MCP server "${input.serverName}" added from the Agentic Chat settings.`,
      },
      null,
      2,
    )}\n`,
  );
  await vault.app.vault.create(
    `${rootPath}/mcp.json`,
    `${JSON.stringify(
      {
        $schema: AGENT_PLUGINS_MCP_SCHEMA_ID,
        mcpServers: {
          [input.serverKey]: { type: "streamable-http", url: input.url },
        },
      },
      null,
      2,
    )}\n`,
  );
  return { rootPath, pluginName, serverKey: input.serverKey };
}

/**
 * The converted package for a single-skill scaffold (New skill wizard and the
 * agent `create_skill` tool): a spec-valid manifest plus skills/<name>/SKILL.md.
 * Throws a user-readable error for a bad name or an oversized body.
 */
export function scaffoldSkillPackage(input: { name: string; description: string; body: string }): ConvertedPackage {
  if (!/[a-z0-9]/i.test(input.name)) {
    throw new Error("Skill name must contain at least one letter or digit.");
  }
  const name = slugifyPluginName(input.name);
  if (!name || !validatePluginName(name)) throw new Error("Skill name must contain at least one letter or digit.");
  const body = input.body.trim();
  if (body.length > MAX_SKILL_BODY_CHARS) {
    throw new Error(
      `Skill body is too large (${body.length} chars, max ${MAX_SKILL_BODY_CHARS}). Split it or shorten it.`,
    );
  }
  const description = input.description || `${name} skill.`;
  return {
    name,
    description,
    native: false,
    skills: [
      {
        name,
        files: new Map([
          [
            "SKILL.md",
            new TextEncoder().encode(`---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}\n`),
          ],
        ]),
        warnings: [],
      },
    ],
    mcpEntries: [],
    rootFiles: new Map(),
    warnings: [],
  };
}

/** First free directory name in `usedDirs`: `base`, then `base-2`, `base-3`, ... */
function uniqueSkillDir(base: string, usedDirs: Set<string>): string {
  let dir = base;
  let suffix = 2;
  while (usedDirs.has(dir)) {
    dir = `${base}-${suffix}`;
    suffix += 1;
  }
  return dir;
}
