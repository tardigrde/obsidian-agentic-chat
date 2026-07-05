import type { Skill } from "@earendil-works/pi-agent-core";

/** Marker `filePath` for skills that ship with the plugin (no vault file backs them). */
export const BUILTIN_SKILL_LOCATION = "(built-in)";

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

/** The deep-research skill: plan → search → read → synthesize → cite → save. */
export const DEEP_RESEARCH_SKILL: Skill = {
  name: "deep-research",
  description:
    "Multi-step web research: plan, search, read sources, then write a cited research note into the vault. Requires web access.",
  content: DEEP_RESEARCH_CONTENT,
  filePath: BUILTIN_SKILL_LOCATION,
};

/**
 * Skills that ship with the plugin (no vault folder needed). Some depend on web
 * access, so they're gated: deep-research only appears when the web tools exist.
 */
export function builtinSkills(webEnabled: boolean): Skill[] {
  return webEnabled ? [DEEP_RESEARCH_SKILL] : [];
}
