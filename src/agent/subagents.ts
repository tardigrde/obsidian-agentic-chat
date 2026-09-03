/**
 * A subagent role: a focused child agent the main agent can delegate to.
 * S8 reframe: the isolation value is a clean context window for a subtask,
 * not a switchable persona. The child's toolAllowlist is advisory;
 * parent approval/mode still governs.
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

const EXPLORER_PROMPT = `You are an explorer subagent inside Obsidian. You investigate one focused question against the user's vault and report back.

- Use read, search, and ls for vault evidence; use web_search and fetch_url when web research is part of the task.
- Fetch promising web results before relying on them. Prefer primary/authoritative sources and keep their source artifact ids or URLs.
- Read relevant notes/source artifacts before drawing conclusions; never guess paths or cite snippets you did not inspect.
- Return a tight, sourced summary: answer first, then the note paths, source artifact ids, and URLs you relied on.
- When asked to review a draft claim set, source list, note, or plan, be skeptical: flag unsupported claims, stale/low-authority sources, missing citations, and contradictions, ordered by severity with evidence for each finding.
- You cannot change the vault. Do not propose running other tools.`;

/** Single built-in role: read-only recon. */
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

// Freeze the built-in roster so a caller mutating a returned role cannot
// escalate the singleton for the rest of the session.
for (const role of BUILTIN_AGENT_ROLES) {
  Object.freeze(role.toolAllowlist);
  Object.freeze(role);
}
Object.freeze(BUILTIN_AGENT_ROLES);

/** Normalize a dispatch name for lookup: trim + case-insensitive (models capitalize). */
export function normalizeAgentName(name: string): string {
  return name.trim().toLowerCase();
}

/** Case-insensitive role lookup (trims the request). */
export function findAgentRole(roles: Pick<AgentRole, "name">[], name: string): AgentRole | undefined {
  const wanted = normalizeAgentName(name);
  return (roles as AgentRole[]).find((candidate) => candidate.name.trim().toLowerCase() === wanted);
}

/**
 * Load the available subagent roles. Currently the built-in roster only;
 * custom roles are not supported — extend BUILTIN_AGENT_ROLES in code.
 * Returns deep clones so callers cannot mutate the frozen singleton.
 */
export function loadAgentRoles(): AgentRole[] {
  return BUILTIN_AGENT_ROLES.map((role) => ({ ...role, toolAllowlist: [...role.toolAllowlist] }));
}

/** Strip newlines/control chars and cap length so role text cannot inject prompt structure. */
function sanitizeRoleText(value: string, maxLength: number): string {
  return value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

/** Format the model-visible block advertising the available subagents. */
export function formatAgentRolesForSystemPrompt(roles: AgentRole[]): string {
  if (roles.length === 0) return "";
  const lines = roles.map(
    (role) => `- **${sanitizeRoleText(role.name, 64)}**: ${sanitizeRoleText(role.description, 200)}`,
  );
  return [
    "## Subagents",
    "",
    "You can delegate focused subtasks to these specialist subagents with the `subagent` tool. " +
      "One call runs one subagent ({agent, task}); make several `subagent` calls in one message " +
      "to run several in parallel (up to 10 at once). " +
      "Delegate work that is self-contained (research, review) to keep your own context clean. " +
      "Subagents inherit your approval/mode controls; the built-in Explorer role is read-only recon.",
    "",
    ...lines,
  ].join("\n");
}
