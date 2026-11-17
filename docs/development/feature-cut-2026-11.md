# Feature-slice audit, November 2026

This ledger examines 14 product feature slices. A slice is a user-visible
capability plus its code, settings, tests, and docs. The direction is "core
first": a feature stays only when it earns its place.

The verdicts are `keep`, `shrink`, or `cut`. The same PR applies each `shrink`
and `cut`, with one exception (slice 9). There is one commit for each slice, so you can revert one slice
alone.

## How the cost was measured

- Lines: `wc -l` on the files of the slice at `90dd918`.
- Fixes: `git log --since=2026-09-14` on the files of the slice. Only commits
  with a `fix` prefix are counted.
- Tokens: `estimateToolDefinitionTokens` (JSON length divided by 4) on the
  parent tool list. The configuration is the default: web off, no MCP server,
  `create_skill` on. Before the cut, the model gets 20 tools and 2,337 tool
  tokens on each request. The default system prompt is 1,041 tokens.
- `docs/development/escaped-defects.md` has no rows. No slice has a recorded
  escaped defect. The fix counts are the only defect signal.

## Summary

| # | Slice | Cost (src / test lines) | Verdict | Reason |
|---|---|---|---|---|
| 1 | MCP | 4,926 / 3,413 | keep | It is the only way to add remote tools. |
| 2 | Agent plugin install and catalog | 1,730 + 2,698 vendored / 1,250 | keep | It has a proven journey and no fixes. |
| 3 | Semantic index | 2,045 / 1,864 | cut | Nothing reads the index. |
| 4 | Document import | 1,913 / 1,080 | shrink | `import_pdf` is a copy of `import_document`. |
| 5 | Memory | 1,093 / 751 | cut | ADR 0004 already says the value is too small. |
| 6 | Skills | 1,023 / 518 | keep | Skills are the extension point of the product. |
| 7 | Subagents | 1,024 / 948 | keep | The value is not known. The cost is zero when not used. |
| 8 | Web search and fetch | 940 / 691 | keep | Off by default. No tokens when off. |
| 9 | Observability export | 823 / 341 | cut, not applied | The session JSONL is already the local trace. The cut needs a different session. |
| 10 | Artifacts | 745 / 647 | keep | Web, MCP, import, and compaction need it. |
| 11 | Cost and usage readouts | 626 / about 400 | keep | The spend cap is a safety control. |
| 12 | Quick Ask | 264 / 118 | keep | It is small and it is the only editor entry point. |
| 13 | Output styles | 52 / 15 | cut | Two prompt overlays. `AGENTS.md` does the same. |
| 14 | Slash commands that duplicate | about 40 / about 30 | keep | `/status` is a subset of `/doctor`, but the test harness uses it. |

## 1. MCP

- **What it does.** The agent calls tools on remote Streamable HTTP servers.
  The user adds a server in settings.
- **Entry points.** Advanced > MCP (add, enable, auth, approval). Tools named
  `mcp__<server>__<tool>`. `/doctor` rows.
- **Cost.** 4,926 lines in `src/` (`src/mcp/`, `src/settings-mcp-*.ts`). 3,413
  lines in `test/`. Two global settings plus the state for each server. No
  tokens when no server is enabled. 5 fixes (#216, #218, #231, #346, #358).
  It couples to plugins (the package owns the server), secrets, artifacts, and
  the approval gate.
- **Value.** It is the only way to give the agent a tool that the plugin does
  not ship. A committed e2e spec covers the settings journey.
- **Verdict.** `keep`. OAuth is the largest part (about 1,240 lines). Examine
  it alone in a later round. I do not know if the owner uses an OAuth server.
- **Blast radius.** Not applicable.

## 2. Agent plugin install and catalog

- **What it does.** The user installs a plugin package from a GitHub URL, an
  archive, or a vault folder. The importer converts Claude, Codex, and Copilot
  packages. A marketplace file shows a pick list.
- **Entry points.** Advanced > Agent plugins > **Install plugin…**. The
  `install-plugin` built-in skill.
- **Cost.** 1,730 lines in `src/plugins/import/`, `import-sweep.ts`, and
  `install-plugin-modal.ts`. 2,698 lines of vendored `fflate` that only the
  archive reader uses. About 1,250 lines of tests. No settings. No tools.
  No fixes in two months.
- **Value.** Without it, the user must copy a folder into `.agentic-plugins/`
  by hand. `composio-install.e2e.ts` proved a real journey (deleted in #393 T13; the archive install is now in `settings-ui.e2e.ts`).
- **Verdict.** `keep`. The cost is large, but the model pays nothing, the
  journey has a test, and the code is stable. The format converters (Claude,
  Codex, Copilot) are the first part to examine if this slice returns.
- **Blast radius.** Not applicable.

## 3. Semantic index

- **What it does.** `/semantic-index start` sends note text to an embedding
  provider and writes vectors to `semantic-index/index.json`.
- **Entry points.** `/semantic-index [status|estimate|start|cancel]`.
  Advanced > Semantic retrieval (9 rows).
- **Cost.** 2,045 lines in `src/`. 1,864 lines in `test/`. 10 setting keys.
  No tools. 6 fixes in two months for the lease and the atomic write (#218,
  #227, #232, #237, #249, #296). The index costs the user money for embedding
  calls.
- **Value.** None today. **No code reads the index.** No tool searches it, and
  nothing injects results into a prompt. The user pays for embeddings and gets
  a file. The docs say that the agent searches the index. That is not true.
- **Verdict.** `cut`. This matches the rule: no user, no proven journey, and a
  history of fixes. If semantic search returns, start from the search tool,
  not from the index.
- **Blast radius.** `src/retrieval/` (embeddings, semantic index, policy,
  relevant notes), `src/settings-tab-retrieval.ts`, `src/ui/semantic-index-*`,
  the `embeddings` setting, the lease scope in `src/main.ts`, the slash
  command, and the docs page.

## 4. Document import

- **What it does.** The agent extracts text from a vault PDF, EPUB, DOCX, PPTX,
  or XLSX file into an artifact with citation anchors.
- **Entry points.** Tools `import_pdf` and `import_document`.
- **Cost.** 1,913 lines in `src/`. 1,080 lines in `test/`. No settings. Two
  tools: 228 tokens on each request. 1 fix (#346).
- **Value.** A vault often holds PDF files. Without this slice the agent cannot
  read them. I do not know how frequently the owner uses the other formats.
- **Verdict.** `shrink`. Remove the `import_pdf` tool. `import_document`
  accepts PDF files and uses the same code path. ADR 0002 already calls
  `import_pdf` an optional alias. This saves 106 tokens on each request.
- **Blast radius.** `src/tools/document-tools.ts`, the tool-budget drop rule,
  the self-knowledge skill text, and the tests that call `import_pdf`.

## 5. Memory

- **What it does.** The user stores short memories with `/memory add`. The
  agent can search them with `search_memory`.
- **Entry points.** `/memory [add|review|manage|export|clear]`. Tool
  `search_memory`.
- **Cost.** 1,093 lines in `src/` (`src/memory/`, the tool, the workflow
  controller, the lexical tokenizer). 751 lines in `test/`. No settings. One
  tool: 136 tokens on each request. 1 fix (#346).
- **Value.** Low. The plugin does not inject memories. The agent must decide to
  call `search_memory`. ADR 0004 says: "That is not enough value", and names
  `AGENTS.md` as the durable memory. `/init` already maintains `AGENTS.md`.
- **Verdict.** `cut`. An existing `memories.jsonl` file stays on disk. The
  plugin does not read it and does not delete it.
- **Blast radius.** `src/memory/`, `src/tools/memory-tools.ts`,
  `src/ui/memory-workflow-controller.ts`, `src/retrieval/lexical.ts`, the
  slash command, the self-knowledge skill text, and the docs page.

## 6. Skills

- **What it does.** Skills are Markdown instructions in plugin packages. The
  user runs one with `/skill` or `/<name>`. The agent reads or loads one.
- **Entry points.** `/skill`, `/<skill-name>`, **New skill…**. Tools
  `read_skill`, `read_skill_file`, `load_skill`, `unload_skill`,
  `create_skill`.
- **Cost.** 1,023 lines in `src/`. 518 lines in `test/`. Five tools: 512
  tokens on each request. 3 fixes.
- **Value.** Skills are how the user extends the agent without code. The
  built-in `self-knowledge` skill keeps the system prompt short.
- **Verdict.** `keep`. Five tools is many. `load_skill` and `unload_skill`
  (138 tokens) overlap with `read_skill`. But a loaded skill stays in the
  prompt after compaction, and a read result does not. I do not know which
  one the models use more. Measure that in the session traces before a cut.
- **Blast radius.** Not applicable.

## 7. Subagents

- **What it does.** The agent gives a read-only search task to one `explorer`
  child agent.
- **Entry points.** Tool `subagent`. `/agent [name] [task]`. Advanced >
  Subagents > timeout.
- **Cost.** 1,024 lines in `src/`. 948 lines in `test/`. One setting. One
  tool: 131 tokens. 2 fixes (#214, #216).
- **Value.** Not known. The child keeps long searches out of the parent
  context. A replay e2e spec covers it.
- **Verdict.** `keep`. `/agent` duplicates the tool, but it is the only way
  for the user to force a delegation. It stays for now.
- **Blast radius.** Not applicable.

## 8. Web search and fetch

- **What it does.** The agent searches the web and fetches a page.
- **Entry points.** Advanced > Web (8 keys). Tools `web_search` and
  `fetch_url`. The `deep-research` skill.
- **Cost.** 940 lines in `src/`. 691 lines in `test/`. Off by default, so no
  tokens until the user enables it. 1 fix (#346).
- **Value.** It is the only source of data outside the vault.
- **Verdict.** `keep`. Three search providers is more than one user needs, but
  each provider is about 30 lines.
- **Blast radius.** Not applicable.

## 9. Observability export

- **What it does.** The plugin sends turn traces to Langfuse or to an OTLP
  endpoint.
- **Entry points.** Advanced > Observability (backend, endpoint, sample rate,
  payload mode, three secrets, proxy). `/doctor` rows.
- **Cost.** 823 lines in `src/observability/`. 341 lines in `test/`. 13 setting
  keys and 3 secret slots. No tools. 1 fix (#346). It couples to the agent
  service, the diagnostics, the secret store, and the settings tab.
- **Value.** Low for a personal vault plugin. Each session already writes a
  JSONL trace, and the repo has a trace analyzer (`npm run analyze:session`).
  The chaos and eval lanes use the JSONL, not the export. The export is also a
  path that can send prompt text off the device.
- **Verdict.** `cut`, but **not applied in this PR**. The cut must edit the
  secret slot table in `src/secrets/secret-store.ts` and its test. A deny rule
  blocked that file in the session that made this PR, and a partial cut is
  worse than no cut. The slice is complete and unchanged. The action audit log
  is a different thing. It writes to the session file and it stays.
- **Blast radius.** `src/observability/`, `AgentService`, `diagnostics.ts`,
  the secret slot table, `settings-tab-web.ts`, the `observability` setting,
  and the docs.

## 10. Artifacts

- **What it does.** A large tool output goes to a file. The model gets a short
  reference and can read or search the file.
- **Entry points.** Tools `read_artifact`, `search_artifact`,
  `export_artifact` (and `list_artifacts`).
- **Cost.** 745 lines in `src/`. 647 lines in `test/`. 340 tokens on each
  request. No fixes.
- **Value.** Web fetch, MCP, document import, and compaction depend on it. It
  keeps large outputs out of the context.
- **Verdict.** `keep`. `export_artifact` (108 tokens) is the weakest tool. I do
  not know if a model ever calls it. Check the traces first.
- **Blast radius.** Not applicable.

## 11. Cost and usage readouts

- **What it does.** The toolbar shows tokens, cost, and context load. A cost
  alert and a cost cap can stop a session.
- **Entry points.** The context bar. `/usage`. Advanced > Notifications.
- **Cost.** About 626 lines in `src/`. 3 settings. No tools. 3 fixes (#277,
  #297, #346).
- **Value.** The cap is a safety control for a paid API. The context readout
  drives auto-compaction.
- **Verdict.** `keep`.
- **Blast radius.** Not applicable.

## 12. Quick Ask

- **What it does.** An editor command opens a small modal. The model proposes
  an edit for the selection.
- **Entry points.** Command palette: `quick-ask-inline-edit`.
- **Cost.** 264 lines in `src/`. 118 lines in `test/`. No settings. No tools.
  2 fixes (#324, #352).
- **Value.** It is the only entry point from the editor. I do not know how
  frequently the owner uses it.
- **Verdict.** `keep`. It is small.
- **Blast radius.** Not applicable.

## 13. Output styles

- **What it does.** `/style` adds a "brainstorm" or "learning" paragraph to the
  system prompt.
- **Entry points.** `/style [name]`. The style rows in `/status` and
  `/doctor`.
- **Cost.** 52 lines in `src/agent/output-styles.ts` plus the slash handler and
  the readouts. One setting. No tokens with the default style.
- **Value.** Low. One line in `AGENTS.md`, or one sentence in the prompt, does
  the same. The roadmap lists this slice for review.
- **Verdict.** `cut`.
- **Blast radius.** `output-styles.ts`, the `outputStyle` setting, the system
  prompt composer, the slash handler, the diagnostics rows, and the docs.

## 14. Slash commands that duplicate

- **What it does.** `/status` shows the provider, the model, the mode, and the
  MCP summary. `/doctor` shows the same rows and more.
- **Entry points.** `/status`.
- **Cost.** About 40 lines. It adds one more command to a list of 17.
- **Value.** None for the user that `/doctor` does not give. But the chaos
  actions, the `@break-change` templates, one e2e spec, and the troubleshooting
  guide use `/status` as a cheap local probe.
- **Verdict.** `keep`. The command is about 40 lines. A cut changes more
  harness code than product code. `/usage` and `/help` also stay: each one
  shows data that no other surface shows in full. `/style` goes with slice 13.
- **Blast radius.** Not applicable.
