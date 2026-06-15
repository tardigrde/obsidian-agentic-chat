import type { Skill } from "@earendil-works/pi-agent-core";

/** Marker `filePath` for skills that ship with the plugin (no vault file backs them). */
export const BUILTIN_SKILL_LOCATION = "(built-in)";

const DEEP_RESEARCH_CONTENT = `# Deep research

Run a multi-step research loop on the open web and capture the findings as a cited note in the vault. Use the \`web_search\` and \`fetch_url\` tools.

Follow these steps:

1. **Plan.** Restate the question in one line, then list the 3–6 sub-questions you must answer. If the scope is ambiguous, ask the user one clarifying question before searching.
2. **Search.** Run \`web_search\` for each sub-question. Prefer specific queries over broad ones; refine and re-search when results are weak.
3. **Read.** Open the most promising results with \`fetch_url\` (not just the snippets). Favor primary and authoritative sources; corroborate any important claim across at least two independent sources.
4. **Synthesize.** Write the answer in your own words, organized by sub-question. Note where sources disagree or evidence is thin — do not paper over uncertainty.
5. **Cite.** Every non-obvious claim must carry an inline source link. Use Markdown links \`[label](https://…)\` or footnotes, and end the note with a "## Sources" list of every URL you relied on. Never cite a page you did not actually fetch.
6. **Save.** Write the result as a Markdown note in the vault (ask the user for a path/folder if none was given). Include the original question, the date, and the Sources list. Briefly confirm the path you wrote.

Constraints:
- Stay within the user's question; don't pad the note with unrelated background.
- Distinguish what the sources say from your own inference.
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
