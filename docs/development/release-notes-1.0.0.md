# Release notes draft: 0.51.10 → 1.0.0

Status: **draft**. The owner edits and approves this text before the release
(S7 in `NEXT.md`). Hand-written; semantic-release does not generate it.

## What 1.0.0 means

From 1.0.0 these are a promise: tool names, slash commands, settings (the
`data.json` shape), the session file format, and the supported providers and
platforms. A later change to one of them comes with a migration, so your
settings and old conversations keep working.

## Before you upgrade

- Nothing to do by hand. Settings and old conversations load as they are.
- Removed settings are dropped from `data.json` the first time the plugin
  loads. A notice names the ones you used: working directories (it lists
  them), the plan or other retired permission mode, an output style, and the
  semantic index.

## Removed, and what to use instead

| Removed | Use instead | PR |
|---|---|---|
| `/steer`, `/follow-up`, `/followup`, `/redirect` | Type while the agent responds: Enter steers, Queue sends after the turn, Stop then send redirects. | #257 |
| `/config`, `/mode` and command aliases | The Safe/YOLO toggle in the composer, or Settings → Permission mode. | #252 |
| `/history` | `/sessions` | #252 |
| `/thinking` | `/effort` | #252 |
| `/todo`, `/todos` and the todo tracker | Ask the agent to keep a checklist in a note. | #258 |
| Plan mode | Ask the agent for a plan in your message; approvals still guard every write. | #260 |
| `/add-dir`, `/dirs`, `/working-dirs` (working directories) | The agent reads the whole vault. Keep a folder out with Settings → Advanced → Ignored files. | #278 |
| `/semantic-index` and the Semantic retrieval settings | Vault search. The index was never read by any tool. | #368 |
| `/memory` and the memory store | Put durable facts in `AGENTS.md`; `/init` helps you write it. | #368 |
| `/style` and output styles | Put the style you want in `AGENTS.md` or in your message. | #368 |
| The `import_pdf` tool | `import_document` (reads PDF files with the same code). | #368 |
| The Tool budget setting | Rarely used tools load on demand through `search_tools`. | #391 |
| Settings tabs | Three tabs now. | #256 |

Typing a removed command shows what replaces it. Typing any other unknown
command (a typo such as `/sesions`) now shows "Unknown command" with a `/help`
hint. It is not sent to the model.

## Tool names (for per-tool approval rules)

| Old | New |
|---|---|
| `read_skill`, `read_skill_file` | `skill` (`action: read` / `read_file`) |
| `load_skill`, `unload_skill` | removed; use `skill` with `action: read` |
| `list_artifacts`, `read_artifact`, `search_artifact`, `export_artifact` | `artifact` (`action: list` / `read` / `search` / `export`) |
| `ls`, `search`, `find`, `grep`, `get_active_note`, `get_backlinks`, `get_links`, `local_graph`, `get_properties` | `vault_inspect` |
| — | new: `search_tools`, `current_time` |

An approval rule that names a removed tool has no effect. **Check this one:** if
you hand-edited `data.json` to `deny` an artifact tool, that rule is gone, and
the new `artifact` tool is allowed (every artifact action is read-only).

## Changed behavior

- Deleting a conversation from history moves its file to the vault's `.trash`
  folder, so you can get it back. `/sessions clear --confirm` does the same for
  every conversation. If the vault trash fails, the file is deleted for good.
- History shows a conversation file it cannot read as "Unreadable
  conversation", with a delete button, instead of hiding it.
- Deleting a note: when the system trash does nothing (a Linux desktop with no
  trash service), the note goes to the vault `.trash`. If that fails too, the
  note is deleted and the result says "bypassed trash".
- Deleting or clearing a conversation that another chat tab has open moves that
  tab to a fresh conversation.

## Not changed

- Providers: OpenRouter, OpenAI-compatible gateways (for example OpenWebUI),
  and the others in Settings.
- Desktop and mobile.
- Observability export (Langfuse, OTLP) stays.
