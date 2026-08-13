import { AGENT_PLUGINS_MCP_SCHEMA_ID, AGENT_PLUGINS_SCHEMA_ID, slugifyPluginName } from "../manifest";
import type { FileTree } from "./archive";
import type { ConvertedPackage } from "./convert";

/** Minimal vault write surface so installs run against the real vault or a test double. */
export interface PackageWriter {
  /** Create a folder path (all segments). No-op when it already exists. */
  ensureFolder(path: string): Promise<void>;
  /** Write a text or binary file, creating parent folders. */
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  /** Recursively remove a folder. */
  removeFolder(path: string): Promise<void>;
  /** True when the folder exists. */
  folderExists(path: string): Promise<boolean>;
  /** Move a folder, replacing any existing target. */
  renameFolder(from: string, to: string): Promise<void>;
}

export interface InstallPackageOptions {
  /** Plugin package as converted from the source. */
  converted: ConvertedPackage;
  /** Native raw plugin.json to pass through (mutually exclusive with converted.manifest fields). */
  nativeManifest?: string;
  /** Vault folder the packages live in (".agentic-plugins"). */
  pluginsFolder: string;
}

export interface InstallResult {
  /** Vault path of the installed package directory. */
  rootPath: string;
  /** Slugged package name (== final directory name). */
  name: string;
  /** True when a same-named package was replaced. */
  updated: boolean;
  skills: number;
  mcpServers: number;
  /** Total files written, including plugin.json/mcp.json. */
  files: number;
  warnings: string[];
}

/**
 * Write a converted package into the plugins folder. The package is staged
 * under a temp directory and renamed into place, so a crash never leaves a
 * half-written plugin; plugin.json is written last inside the stage.
 * Re-importing a same-named package replaces it in place (an update).
 */
export async function installPackage(writer: PackageWriter, options: InstallPackageOptions): Promise<InstallResult> {
  const { converted, pluginsFolder } = options;
  const name = slugifyPluginName(converted.name) || "plugin";
  const stage = `${pluginsFolder}/.importing-${name}-${Date.now().toString(36)}`;
  const target = `${pluginsFolder}/${name}`;

  await writer.ensureFolder(pluginsFolder);
  await writer.ensureFolder(stage);

  let files = 0;
  for (const skill of converted.skills) {
    for (const [rel, bytes] of skill.files) {
      const path = `${stage}/skills/${skill.name}/${rel}`;
      await writer.writeFile(path, bytes);
      files += 1;
    }
  }
  if (converted.mcpEntries.length > 0) {
    await writer.writeFile(
      `${stage}/mcp.json`,
      `${JSON.stringify(
        {
          $schema: AGENT_PLUGINS_MCP_SCHEMA_ID,
          mcpServers: Object.fromEntries(
            converted.mcpEntries.map((entry) => [
              entry.key,
              { type: "streamable-http", url: entry.url, ...(entry.headers ? { headers: entry.headers } : {}) },
            ]),
          ),
        },
        null,
        2,
      )}\n`,
    );
    files += 1;
  }
  for (const [rel, bytes] of converted.rootFiles) {
    await writer.writeFile(`${stage}/${rel}`, bytes);
    files += 1;
  }
  // plugin.json last (D5): the loader ignores manifest-less directories, so a
  // crash while staging leaves an invisible package that re-import repairs.
  const manifest = options.nativeManifest ?? convertedManifest(converted);
  await writer.writeFile(`${stage}/plugin.json`, `${manifest}\n`);
  files += 1;

  const updated = await replaceIntoPlace(writer, stage, target);

  return {
    rootPath: target,
    name,
    updated,
    skills: converted.skills.length,
    mcpServers: converted.mcpEntries.length,
    files,
    warnings: converted.warnings,
  };
}

/** Move the staged package onto the target, replacing any existing package. */
async function replaceIntoPlace(writer: PackageWriter, stage: string, target: string): Promise<boolean> {
  // The loader skips the stage folder? It does not filter hidden folders today,
  // so a leftover stage would be picked up as a broken package. Clean it up.
  const existing = await folderExists(writer, target);
  if (existing) await writer.removeFolder(target);
  await renameFolder(writer, stage, target);
  return existing;
}

async function folderExists(writer: PackageWriter, path: string): Promise<boolean> {
  return writer.folderExists(path);
}

async function renameFolder(writer: PackageWriter, from: string, to: string): Promise<void> {
  await writer.renameFolder(from, to);
}

/** Build the plugin.json text for converted (non-native) packages. */
function convertedManifest(converted: ConvertedPackage): string {
  const manifest: Record<string, unknown> = {
    $schema: AGENT_PLUGINS_SCHEMA_ID,
    name: converted.name,
    version: converted.version ?? "1.0.0",
    description: converted.description ?? "",
  };
  return JSON.stringify(manifest, null, 2);
}

/** Build a plugin.json for freshly scaffolded single-skill packages. */
export function scaffoldManifest(name: string, description: string): string {
  return `${JSON.stringify(
    {
      $schema: AGENT_PLUGINS_SCHEMA_ID,
      name: slugifyPluginName(name),
      version: "1.0.0",
      description,
    },
    null,
    2,
  )}\n`;
}

export { slugifyPluginName };
export type { FileTree };