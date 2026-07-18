import type { Skill } from "@earendil-works/pi-agent-core";

/** Marker `filePath` for skills that ship with the plugin (no vault file backs them). */
export const BUILTIN_SKILL_LOCATION = "(built-in)";

const SELF_KNOWLEDGE_CONTENT = `# Self-knowledge

Consult this skill proactively when: the user is unhappy with how the agent is working, you see repeated tool-call errors on the same operation, a doomloop is detected, or you are asked about your own capabilities, constraints, or plugin identity.

## Tools inventory

You have these tool categories. Each is callable via function call when present in your active tool set; some may be dropped by the tool budget (see below).

- **Vault**: read, vault_inspect, write, edit, rename, delete, set_properties, ls, search, grep, find, get_active_note, get_backlinks, get_links, local_graph, get_properties.
- **Web** (optional): web_search, fetch_url.
- **Subagent** (optional): subagent — delegate focused subtasks to specialist child agents. Max 20 tasks per dispatch, 8 concurrency, sequential execution mode. Do not spawn subagents after being told not to.
- **Artifacts** (optional): list_artifacts, read_artifact, search_artifact, export_artifact.
- **Memory** (optional): search_memory.
- **Documents** (optional): import_pdf, import_document.
- **MCP** (optional): remote tools from configured MCP servers.
- **Ask-user**: ask_user — ask the user a question with optional choices.
- **External workspace** (desktop only, optional): external_inspect — read/list/search an external root directory.
- **Read-skill**: read_skill — load the full body of any skill by name, including this one.

## Edit semantics

- Read a note before editing it.
- Use \`edit\` for small, exact changes (oldText/newText). It preserves the rest of the file.
- Use \`write\` to create a new file or fully replace an existing one.
- Use \`set_properties\` for frontmatter/property-only changes; do not rewrite raw YAML by hand.

## Approval modes and boundaries

- Mutating tools (write, edit, rename, delete, set_properties) pass through an approval gate. The user or policy may deny them.
- If a tool action is denied, treat it as a boundary, not a system or tool failure. Do not retry the same denied mutation. Explain the boundary and choose a safe alternative.

## Tool budget behavior

- Optional tools (web, MCP, subagent, artifacts, document import) may be silently dropped when the total tool-schema size exceeds a threshold (default 2% of the context window).
- If a tool you expected is missing, it was likely withheld by the budget, not broken. Use the diagnostics readout to check dropped tools.

## Context hygiene

- Attachments and the active note may appear in the prompt as path-only references when they are large or restricted. If you only see a path and need the contents, call read.
- Do not re-read a note whose content is already in this conversation just to "check" — it is above.
- Use vault_inspect or a bounded read (startLine/endLine or offset/limit) when you need a specific part of a large file.
- Pay attention to token usage and context bloat. Prefer search, listings, and bounded reads first.

## Paths and privacy

- All paths are vault-relative (e.g. "Folder/Note.md"); never use absolute paths.
- Some paths are ignore-listed (private) and can never be read, listed, or searched. Treat them as if they do not exist, and never try to work around that.

## Doomloop guard

- If the same tool fails more than twice on the same path/operation, stop. Do not retry the identical call again.
- Consult this skill, then ask the user or switch to a different approach (e.g., vault_inspect to verify the path, or ask_user for clarification).

## Error pattern catalog

- Permission denied = boundary; do not retry.
- Not found → use vault_inspect first; do not guess paths.
- Tool budget dropped optional tool = withheld, not broken; check diagnostics.
- Repeated identical errors → doomloop; escalate to user.

## Model identity

- You may be switched between models mid-session. State your current model when asked.
- You are the "agentic-chat" Obsidian plugin.

## Plugin URLs

- Plugin page: https://community.obsidian.md/plugins/agentic-chat
- Source repository: https://github.com/tardigrde/obsidian-agentic-chat
- Report issues: https://github.com/tardigrde/obsidian-agentic-chat/issues

When a user reports a bug or unexpected behavior, you can point them to the issues URL above to open a new issue.`;

const DEEP_RESEARCH_CONTENT = `# Deep research

Run a subagent-backed research loop on the open web and capture the findings as a cited note in the vault. You are the supervisor: plan the investigation, dispatch children with the \`subagent\` tool, verify their evidence, synthesize the final note, then save it.

Follow these steps:

1. **Plan as supervisor.** Restate the question in one line, then list the 3-6 sub-questions you must answer. If the scope is ambiguous, ask the user one clarifying question before searching.
2. **Dispatch parallel searchers.** Use \`subagent\` with \`tasks\` and \`concurrency\` to run 2-6 \`researcher\` children in parallel. Give each child one focused sub-question and explicitly tell it to use \`web_search\` and \`fetch_url\`, fetch promising results before relying on them, and return claim-by-claim evidence with source artifact ids and URLs.
3. **Read and consolidate evidence.** Inspect child summaries. Use \`read_artifact\` or \`search_artifact\` for saved source artifacts when a claim depends on a large fetched source. Run extra \`web_search\`/\`fetch_url\` yourself only to close obvious gaps.
4. **Dispatch an adversarial verifier.** Use \`subagent\` to run the \`reviewer\` on your draft claim set and source list. Ask it to flag unsupported claims, stale/low-authority sources, missing citations, and contradictions.
5. **Synthesize.** Write the answer in your own words, organized by sub-question. Note where sources disagree or evidence is thin; do not paper over uncertainty.
6. **Cite.** Every non-obvious claim must connect to evidence: prefer saved source artifact citations when available, or inline Markdown links \`[label](https://...)\`. End the note with a "## Sources" list of every source artifact id and URL you relied on. Never cite a page you did not actually fetch or inspect.
7. **Save.** Write the result as a Markdown note in the vault (ask the user for a path/folder if none was given). Include the original question, the date, a short methods note naming the subagent fan-out and verifier, and the Sources list. Briefly confirm the path you wrote.

Constraints:
- Stay within the user's question; don't pad the note with unrelated background.
- Distinguish what the sources say from your own inference.
- If \`subagent\` is unavailable, say you are falling back to a single-agent research loop and still use \`web_search\`, \`fetch_url\`, source artifacts, citations, and verification.
- If web access fails or returns nothing useful, say so plainly rather than inventing sources.`;

/** The self-knowledge skill: plugin capabilities, constraints, error patterns, doomloop guards, and URLs. Always available. */
export const SELF_KNOWLEDGE_SKILL: Skill = {
  name: "self-knowledge",
  description:
    "Plugin self-knowledge: tools inventory, edit semantics, constraints, error patterns, doomloop guards, and plugin URLs. Consult when stuck or when the user is unhappy.",
  content: SELF_KNOWLEDGE_CONTENT,
  filePath: BUILTIN_SKILL_LOCATION,
};

/** The deep-research skill: plan → search → read → synthesize → cite → save. */
export const DEEP_RESEARCH_SKILL: Skill = {
  name: "deep-research",
  description:
    "Multi-step web research: plan, search, read sources, then write a cited research note into the vault. Requires web access.",
  content: DEEP_RESEARCH_CONTENT,
  filePath: BUILTIN_SKILL_LOCATION,
};

/**
 * Skills that ship with the plugin (no vault folder needed).
 * Self-knowledge is always present; deep-research is gated on web access.
 */
export function builtinSkills(webEnabled: boolean): Skill[] {
  return webEnabled ? [SELF_KNOWLEDGE_SKILL, DEEP_RESEARCH_SKILL] : [SELF_KNOWLEDGE_SKILL];
}
