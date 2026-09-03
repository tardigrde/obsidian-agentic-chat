import { type App, type TFile } from "obsidian";
import { splitFrontmatter, stringField } from "../skills/skills";
import { normalizeFolderPath } from "../vault/path";

/**
 * A subagent role: a focused child agent the main agent can delegate to.
 * S8 reframe: formerly authored as "profile" (AGENT.md + built-in roster) —
 * now a role that inherits from the parent. The isolation value is a clean
 * context window for a subtask, not a switchable persona. Vocabulary no
 * longer collides with outputStyle (default/brainstorm/learning). The child's
 * toolAllowlist is advisory; parent approval/mode still governs. Vault
 * AGENT.md authoring is deprecated but still loaded for backward compat.
 */
export interface AgentRole {
  /** Unique dispatch name. */
  name: string;
  /** One-line summary shown to the model (in the system prompt) and in the UI. */
  description: string;
  /** System prompt for the child agent. Replaces the base prompt. */
  systemPrompt: string;
  /** Optional model id override; falls back to the parent's active model. */
  model?: string;
  /**
   * Tool names the child may call. Empty means "all read-only vault tools".
   * Mutating tools are stripped anyway when the parent is in a read-only mode.
   * Advisory – parent approval gates still apply.
   */
  toolAllowlist: string[];
}

/** @deprecated Use AgentRole – kept as alias for backward compatibility. */
export type AgentProfile = AgentRole;

const EXPLORER_PROMPT = `You are an explorer subagent inside Obsidian. You investigate one focused question against the user's vault and report back.

- Use read, search, and ls for vault evidence; use web_search and fetch_url when web research is part of the task.
- Fetch promising web results before relying on them. Prefer primary/authoritative sources and keep their source artifact ids or URLs.
- Read relevant notes/source artifacts before drawing conclusions; never guess paths or cite snippets you did not inspect.
- Return a tight, sourced summary: answer first, then the note paths, source artifact ids, and URLs you relied on.
- You cannot change the vault. Do not propose running other tools.`;

/** Single built-in role: read-only recon (S8 consolidation from researcher/reviewer/editor). */
export const BUILTIN_AGENT_ROLES: AgentRole[] = [
  {
    name: "explorer",
    description: "Read-only explorer: recon a focused question across the vault (and the web when asked) and report sourced findings.",
    systemPrompt: EXPLORER_PROMPT,
    toolAllowlist: [
      "read",
      "search",
      "ls",
      "get_active_note",
      "web_search",
      "fetch_url",
      "list_artifacts",
      "read_artifact",
      "search_artifact",
    ],
  },
];

/**
 * @deprecated Use BUILTIN_AGENT_ROLES – alias for backward compatibility.
 * Points to the same single Explorer roster.
 */
export const BUILTIN_AGENT_PROFILES: AgentRole[] = [...BUILTIN_AGENT_ROLES];

/**
 * Load the available subagent roles: the built-in roster (optional) plus any
 * vault `AGENT.md` files. A vault role overrides a built-in of the same name.
 * Vault AGENT.md is deprecated – roles now inherit from parent and the
 * built-in Explorer covers recon; vault files still load with a warning.
 */
export async function loadAgentRoles(
  app: App,
  folderInput: string,
  includeBuiltins: boolean,
): Promise<AgentRole[]> {
  const byName = new Map<string, AgentRole>();
  if (includeBuiltins) {
    for (const role of BUILTIN_AGENT_ROLES) byName.set(role.name, role);
  }
  const vaultRoles = await loadVaultAgentRoles(app, folderInput);
  if (vaultRoles.length > 0) {
    console.warn(
      "Agentic chat: AGENT.md subagent profiles are deprecated – subagents now inherit from parent; vault AGENT.md still loaded but will be removed in a future version. Migrate to the built-in Explorer role.",
    );
  }
  for (const role of vaultRoles) {
    byName.set(role.name, role);
  }
  return [...byName.values()];
}

/** @deprecated Use loadAgentRoles – alias for backward compatibility. */
export const loadAgentProfiles = loadAgentRoles;

/** Format the model-visible block advertising the available subagents. */
export function formatAgentRolesForSystemPrompt(roles: AgentRole[]): string {
  if (roles.length === 0) return "";
  const lines = roles.map((role) => `- **${role.name}**: ${role.description}`);
  return [
    "## Subagents",
    "",
    "You can delegate focused subtasks to these specialist subagents with the `subagent` tool. " +
      "One call runs one subagent ({agent, task}); make several `subagent` calls in one message " +
      "to run several in parallel (up to 10 at once). " +
      "Delegate work that is self-contained (research, review) to keep your own context clean. " +
      "Subagents inherit your approval/mode controls; the Explorer role is read-only recon.",
    "",
    ...lines,
  ].join("\n");
}

/** @deprecated Use formatAgentRolesForSystemPrompt – alias for backward compatibility. */
export const formatSubagentsForSystemPrompt = formatAgentRolesForSystemPrompt;

async function loadVaultAgentRoles(app: App, folderInput: string): Promise<AgentRole[]> {
  const folder = safeFolder(folderInput);
  if (folder === null) return [];

  const files = app.vault.getMarkdownFiles().filter((file) => {
    if (!isUnder(file.path, folder)) return false;
    if (file.name.toLowerCase() === "agent.md") return true;
    return (file.parent?.path ?? "") === folder;
  });

  const roles: AgentRole[] = [];
  for (const file of files.sort((a, b) => a.path.localeCompare(b.path))) {
    let raw: string;
    try {
      raw = await app.vault.cachedRead(file);
    } catch (error) {
      // A single unreadable file must not abort the whole load.
      console.warn(`Agentic chat: could not read agent file ${file.path}`, error);
      continue;
    }
    const { data, body } = splitFrontmatter(raw);
    if (!body.trim()) continue;
    const name = stringField(data, "name") ?? deriveName(file);
    roles.push({
      name,
      description: stringField(data, "description") ?? name,
      systemPrompt: body,
      model: stringField(data, "model"),
      toolAllowlist: parseToolList(data.tools),
    });
  }
  return roles;
}

/** Parse a frontmatter `tools` field: a comma/space list or a YAML array. */
function parseToolList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(/[,\s]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function deriveName(file: TFile): string {
  // An `AGENT.md` is named after its containing folder; a bare note after itself.
  if (file.name.toLowerCase() === "agent.md") {
    return file.parent?.path ? file.parent.name : file.basename;
  }
  return file.basename;
}

function isUnder(path: string, folder: string): boolean {
  return folder === "" || path === folder || path.startsWith(`${folder}/`);
}

function safeFolder(folderInput: string): string | null {
  if (!folderInput.trim()) return null;
  try {
    return normalizeFolderPath(folderInput);
  } catch {
    return null;
  }
}
