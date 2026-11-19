# Recipes

Copy-paste prompts for common vault jobs. Each one names the feature it relies
on, so you know what to switch on first. Swap in your own folder and note names.

::: tip Make results repeatable
If you run a recipe often, save it as a skill (*Settings → Advanced → Agent
plugins → New skill…*, or ask the agent to create one) and call it with `/<name>`. See [Agent workflows](../features/agent-workflows.md#skills).
:::

## Read and summarize

**Summarize the open note.** The active note is attached automatically.

```text
Summarize this note in 5 bullets. End with open questions.
```

**Summarize a thread of notes.** `@` attaches notes, headings, or blocks.

```text
Compare @Meeting 2026-11-03 and @Meeting 2026-11-10. What changed, and what is still blocked?
```

**Answer from the whole vault.** The agent searches on its own; the step cards
show which notes it read.

```text
What did I decide about the database migration? Cite the notes with [[links]].
```

## Find and audit

```text
List every note in Projects/ with no `status` property, as a table with links.
```

```text
Find notes that link to [[Acme Corp]] but are not tagged #client.
```

```text
Which notes in Inbox/ are older than 30 days and have no outgoing links?
```

Read-only tools run without approval, so audits never change anything.

## Edit and organize

Every change below shows a diff first. `/undo` reverts the last one.

**Tidy frontmatter.**

```text
Add `status: draft` and `created: <file date>` to every note in Inbox/ that lacks them.
```

**Reorganize a folder.** `rename` updates inbound wikilinks.

```text
Move every note in Inbox/ tagged #meeting into Meetings/2026/, and keep the links working.
```

**Rewrite in place.**

```text
Rewrite the "Summary" section of this note in plain English, under 120 words. Leave the rest untouched.
```

**Split a long note.**

```text
Split this note into one note per H2 section under Topics/, and replace each section with a link.
```

::: tip Batch edits
For many small edits, toggle **YOLO** in the composer so they apply without a
prompt each. Recursive folder deletes still ask, and any per-tool **deny** still
wins. Switch back to **Safe** afterwards.
:::

## Write and plan

```text
Draft a weekly review in Reviews/2026-W47.md from my daily notes since Monday: wins, misses, next week.
```

```text
Turn the action items in this note into a checklist note per owner under People/.
```

```text
Read @Project Atlas and ask me questions until you can write a one-page plan, then write it.
```

The agent can pause and ask you with inline answer buttons (`ask_user`).

## Bring in outside sources

**Import a document.** Works for PDF, EPUB, DOCX, PPTX, and XLSX in the vault.

```text
Import Attachments/Q3-report.pdf and write a summary note with page citations.
```

**Research the web.** Turn on *Settings → Advanced → Web access* first.

```text
/deep-research State of local-first sync engines in 2026
```

`/deep-research` runs parallel Explorer subagents, an adversarial review, and
writes a sourced note with a `## Sources` list.

**Call an external tool.** Add an MCP server under *Advanced → MCP tools*, then
ask for it by name, for example `Use the issue tracker to list my open tickets and link them in today's daily note.`

## Teach the agent your vault

Write the rules once, in `AGENTS.md` at the vault root. They apply to every turn.

```text
/init Our daily notes live in Journal/YYYY-MM-DD.md. Use #status/active, never #active. Never touch Archive/.
```

`/init` reads the vault and proposes small, diffed edits to `AGENTS.md`. See
[Standing instructions](../features/agent-workflows.md#standing-instructions-agents-md).

## Keep a long session cheap

- `/usage` shows tokens and cost so far.
- `/compact keep the decisions and the file list` summarizes older turns now.
- Delegate recon: `/agent explorer Map every note about pricing and list their paths`.
  The Explorer works in its own context window, so the main chat stays short.
- Set a spend cap in *Advanced → Notifications → Cost cap*.

See [Choosing a model](./models.md) for what a turn typically costs.
