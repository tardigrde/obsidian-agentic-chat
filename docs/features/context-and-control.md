# Context and Control

Agentic Chat gives the model context through explicit attachments and bounded tools.

## Context attachments

The active note is auto-attached as a removable chip. You can add note, heading, block, folder, drag-and-drop, and selected-text attachments.

The ignore list always wins. Ignored notes are invisible to the agent and are skipped by auto-attachment.

Root standing-instruction files (`AGENTS.md`, `CLAUDE.md`, and `GEMINI.md`) are also skipped by auto-attachment. They are implicit context whenever present, so they do not need a removable active-note chip.

## Working directories

Working directories grant one or more folders as the active working set.

In Safe mode:

- reads and writes inside granted folders can run according to the configured approval policy
- touching anything outside the granted folders asks first, including reads
- denied tools remain denied
- ignored paths remain invisible

Use `/add-dir` to grant a vault folder and `/dirs` to list or revoke grants.

## Approval gates

Read-only vault tools run without approval. Mutating tools can be configured globally or per tool as:

| Policy | Behavior |
| --- | --- |
| allow | Run without asking. |
| ask | Show arguments and a diff before running. |
| deny | Block the tool. |

YOLO is a session-level allow switch for mutating tools. Per-tool deny still wins.

## Plan mode

`/plan` is sticky and read-only. It blocks writes, edits, renames, deletes, frontmatter changes, and subagent writes until `/endplan`.

## Compaction

Long sessions compact automatically before they overflow the configured context window. Run `/compact [instructions]` to summarize older turns immediately; anything after the command is passed as guidance for what the summary should preserve.

Compaction summaries preserve artifact references for large tool outputs, so
exact source snapshots can be reopened with `read_artifact` or `search_artifact`
after older turns are summarized away.
