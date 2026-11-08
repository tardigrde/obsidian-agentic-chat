# Context and control

Agentic Chat gives the model context through explicit attachments and vault tools. Vault tools accept only vault-relative paths. The plugin rejects `..` and absolute paths, and ignored paths report as not found.

## Context attachments

The active note is attached as a removable chip. You can add note, heading, block, folder, drag-and-drop, and selected-text attachments.

The ignore list always wins. Ignored notes are invisible to the agent and are skipped by auto-attachment.

Root standing-instruction files (`AGENTS.md`, `CLAUDE.md`, and `GEMINI.md`) are also skipped by auto-attachment. They are implicit context whenever present, so they do not need a removable active-note chip.

## Approval gates

Read-only vault tools run without approval. Mutating tools can be configured globally or per tool as:

| Policy | Behavior |
| --- | --- |
| allow | Run without asking. |
| ask | Show arguments and a diff before running. |
| deny | Block the tool. |

YOLO auto-approves most mutating tools until you switch back. Recursive folder deletes still ask, and per-tool deny still wins.

## Compaction

Long sessions compact automatically before they overflow the configured context window. Run `/compact [instructions]` to summarize older turns immediately. Anything after the command is passed as guidance for what the summary should preserve.

The toolbar context percentage reports the full next-request load: the transcript, the system prompt and loaded skills, the active tool schemas, and the response reserve. Hover the context bar to see the section breakdown.

Compaction summaries preserve artifact references for large tool outputs, so you can reopen exact source snapshots with `read_artifact` or `search_artifact` after older turns are summarized away.
