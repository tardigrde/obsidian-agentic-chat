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

## External workspace root

On desktop, you can enable one external workspace root outside the vault from settings or by running `/add-dir` with an absolute folder outside the vault. This registers the read-only `external_inspect` tool only when the feature is enabled and a root path is configured.

The external root is not prompt context and is not a vault working directory. The agent can list, read, and search visible text files on demand, then cite findings with passive `external://relative/path` references. External references are not Obsidian links.

External inspection asks by default. You can deliberately switch it to allow or deny in settings. External tools honor the separate external ignore list, root and nested `.gitignore` files, text/binary and size guards, and never follow symlinks outside the configured root.

Repeated exact external list/read calls are guarded. The first repeat returns a
visible cache hit; further identical repeats return a compact pointer to the
earlier result instead of dumping the same external content into the conversation
again.

External reads can be bounded with `startLine`/`endLine` or byte `offset`/`limit`
so the agent can inspect large files without pulling the whole file into context.
Large external reads are stored as plugin-managed artifacts with a short preview
in the transcript. Artifact cleanup keeps pinned artifacts and prunes ordinary
artifacts by age, count, and total byte budget. Artifacts cited by saved
sessions are retained until those sessions are deleted.

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

Compaction summaries preserve artifact references for large tool outputs and
external inspection cache entries, so exact source snapshots can be reopened with
`read_artifact` or `search_artifact` after older turns are summarized away.
