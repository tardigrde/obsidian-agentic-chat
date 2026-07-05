import { type App, type TFile } from "obsidian";
import { splitFrontmatter, stringField } from "../skills/skills";
import { normalizeFolderPath } from "../vault/path";

/**
 * A subagent profile: a focused child agent the main agent can delegate to.
 * Authored as a built-in (below) or a vault `AGENT.md` (YAML frontmatter + body).
 * The body is the child's system prompt; `toolAllowlist` is its permission boundary.
 */
export interface AgentProfile {
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
   */
  toolAllowlist: string[];
}

const RESEARCHER_PROMPT = `You are a research subagent inside Obsidian. You investigate one focused question against the user's vault and report back.

- Use read, search, and ls for vault evidence; use web_search and fetch_url when web research is part of the task.
- Fetch promising web results before relying on them. Prefer primary/authoritative sources and keep their source artifact ids or URLs.
- Read relevant notes/source artifacts before drawing conclusions; never guess paths or cite snippets you did not inspect.
- Return a tight, sourced summary: answer first, then the note paths, source artifact ids, and URLs you relied on.
- You cannot change the vault. Do not propose running other tools.`;

const REVIEWER_PROMPT = `You are an adversarial reviewer subagent inside Obsidian. You critique a note, plan, or change and surface problems.

- Read the relevant material first with read/search/ls and inspect source artifacts with read_artifact/search_artifact when claims cite them.
- Use web_search/fetch_url only to verify contested or high-impact claims, then cite the fetched source artifact or URL.
- Be specific and skeptical: list concrete issues, risks, unsupported claims, and missing citations — not praise.
- Order findings by severity. For each, say where it is, what evidence supports the finding, and why it matters.
- You cannot change the vault; you only report findings.`;

const EDITOR_PROMPT = `You are an editor subagent inside Obsidian. You apply focused, well-scoped edits to vault notes given clear instructions.

- Read a note before editing it. Prefer edit for small exact changes; use write to create or fully replace a file.
- Make only the changes the task asks for; do not restructure beyond the request.
- After editing, briefly confirm exactly what changed (paths and the nature of each change).`;

/** Built-in subagent roster, vault-native analogues of the pi-subagents set. */
export const BUILTIN_AGENT_PROFILES: AgentProfile[] = [
  {
    name: "researcher",
    description: "Read-only recon: investigate a focused question across the vault and report sourced findings.",
    systemPrompt: RESEARCHER_PROMPT,
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
  {
    name: "reviewer",
    description: "Adversarial read-only reviewer: critique a note, plan, or change and surface problems by severity.",
    systemPrompt: REVIEWER_PROMPT,
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
  {
    name: "editor",
    description: "Apply focused edits to vault notes given clear instructions. Can write and edit files.",
    systemPrompt: EDITOR_PROMPT,
    toolAllowlist: ["read", "search", "ls", "edit", "write"],
  },
];

/**
 * Load the available subagent profiles: the built-in roster (optional) plus any
 * vault `AGENT.md` files. A vault profile overrides a built-in of the same name.
 */
export async function loadAgentProfiles(
  app: App,
  folderInput: string,
  includeBuiltins: boolean,
): Promise<AgentProfile[]> {
  const byName = new Map<string, AgentProfile>();
  if (includeBuiltins) {
    for (const profile of BUILTIN_AGENT_PROFILES) byName.set(profile.name, profile);
  }
  for (const profile of await loadVaultAgentProfiles(app, folderInput)) {
    byName.set(profile.name, profile);
  }
  return [...byName.values()];
}

/** Format the model-visible block advertising the available subagents. */
export function formatSubagentsForSystemPrompt(profiles: AgentProfile[]): string {
  if (profiles.length === 0) return "";
  const lines = profiles.map((profile) => `- **${profile.name}**: ${profile.description}`);
  return [
    "## Subagents",
    "",
    "You can delegate focused subtasks to these specialist subagents with the `subagent` tool. " +
      "Each runs in its own isolated context and returns a summary; pass `tasks` to run several in parallel. " +
      "Delegate work that is self-contained (research, review, bulk edits) to keep your own context clean.",
    "",
    ...lines,
  ].join("\n");
}

async function loadVaultAgentProfiles(app: App, folderInput: string): Promise<AgentProfile[]> {
  const folder = safeFolder(folderInput);
  if (folder === null) return [];

  const files = app.vault.getMarkdownFiles().filter((file) => {
    if (!isUnder(file.path, folder)) return false;
    if (file.name.toLowerCase() === "agent.md") return true;
    return (file.parent?.path ?? "") === folder;
  });

  const profiles: AgentProfile[] = [];
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
    profiles.push({
      name,
      description: stringField(data, "description") ?? name,
      systemPrompt: body,
      model: stringField(data, "model"),
      toolAllowlist: parseToolList(data.tools),
    });
  }
  return profiles;
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
    return file.parent && file.parent.path ? file.parent.name : file.basename;
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
