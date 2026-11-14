# Architecture: one owner per state

Status: plan items 9-12 are merged as GitHub PRs #229-#232. Update this file
when ownership moves; the remaining gaps are listed below.

This file names the single owner for each mutable state, the invariant that owner
must keep, and the failure mode that exists while the state is split. A green
test is not a substitute for a clear owner: two writers can both pass their own
tests and still lose data when they interleave.

Use these terms:

- **Owner**: the code allowed to change the state. Other code may read the state
  or ask the owner to change it.
- **Invariant**: a rule the owner must keep on every path, including failure.
- **Gap**: a current second writer or a missing owner. A gap names the PR that
  closes it.

## Ownership at a glance

| State | Owner | Stored in |
|---|---|---|
| Active session pointer, transcript, the one staleness counter, and temp/backup ownership | `ObsidianSessionManager` with the plugin-owned `SessionWriteRegistry` | session JSONL; counters and write ownership in memory |
| Order of every live-session change (swap, rewind, compaction commit) | `AgentSessionActions` (its `AgentSessionSwapQueue`) | memory |
| Live parent agent, session-local state reset | `AgentConversation` | memory |
| One prompt turn | `AgentPromptTurnRuntime` plus pi `Agent` | memory |
| Steering queue, undelivered steers, the stop policy | `AgentSteeringQueue` | memory |
| Compaction pass (single-flight, summarize) | `AgentCompactionRuntime` | memory |
| Manual and automatic compaction flow, its audit pair | `AgentConversationCompaction` | session JSONL (audit) |
| Approval decision and stop flag | `AgentToolCallController` | memory, plus settings for remembered choices |
| MCP connection state | `McpHttpClient` per request | memory |
| MCP OAuth refresh | `refreshFlights` in `src/mcp/oauth.ts` | memory plus `McpServerSettings.oauth` |
| Plugin settings, save order, change listeners | `SettingsStore` | `data.json`; secrets in Obsidian secretStorage |
| Semantic index writer | `SemanticIndexLeaseRegistry` and `SemanticIndexWorkflowController` | `index.json`, `index.json.bak` |
| Plugin install | `installPackage` transaction | vault folders |

Dependencies point one way: `ui/` calls `AgentService`; `AgentService` wires
the agent runtimes; the runtimes call `AgentSessionActions` for anything that
changes the live session; only `AgentSessionActions` calls the mutating
methods of `AgentConversation`, and only `AgentConversation` calls
`ObsidianSessionManager`.

## Active session

Owner: `ObsidianSessionManager` owns `sessionFile`, the entry log, append,
rewrite, and the two counters below. `AgentConversation`
(`src/agent/conversation.ts`) owns the live parent agent, the cached
`SessionInfo` snapshot, and the reset of session-local state when a transcript
goes live. `AgentSessionActions` is the only sequencer: every swap, rewind, and
compaction commit is one operation of its queue.

### One staleness counter

There is one counter, `sessionGeneration`, owned by the session manager. It
advances on every transcript discontinuity: a committed swap, a pointer move, a
rewrite, a reload. A second value, `conversationGeneration`, is not a second
counter: it is the generation at which the current conversation began.

| Token | Read with | Changes on | Used by |
|---|---|---|---|
| generation | `getActiveSessionGeneration()` / `getBinding()` | swap, rewind, compaction rewrite, reload | every rewrite and reload (`expectedPath` + `expectedGeneration`) |
| conversation | `getConversationGeneration()` / `AgentService.getSessionToken()` | swap commit, rewind commit | every UI send, steer, retry, `/compact` audit pair |

A send survives a compaction (same conversation, shorter transcript) but not a
swap or a rewind. A rewind resolves with the token of the conversation it
produced, so a retry binds its resend to it; the UI never parses a token.

### Swap lifecycle

1. Enqueue on the swap queue. Every later send waits for it (`waitForLive`).
2. Reload vault resources. A failure here leaves the old session live and its
   token valid.
3. Commit: `beginConversation()` advances both counters. Every older token is
   stale from here on.
4. Detach the old agent (unsubscribe first, then abort), so a late event from
   it cannot land in the new file.
5. Move the pointer (create, load, delete, clear), then activate the new
   transcript and reset session-local state.
6. On failure after the commit, restore the previous session, then the most
   recent one, then a fresh one. Never two live agents.

Invariants:

- Only `AgentSessionActions` moves the active pointer or replaces the live
  agent, and only inside its queue.
- Every rewrite carries `expectedPath` and `expectedGeneration`. A stale rewrite
  fails before it writes; it never writes into another session.
- An append captures the active file before it writes. After a swap, the append
  lands in that old file and never in the new one.
- A UI send carries the conversation token. A send whose token changed fails
  with the shared "session changed" message.

## Turn

Owner: `AgentPromptTurnRuntime` owns `inFlight` and the idle waiters. The pi
`Agent` owns `isStreaming`. `AgentSteeringQueue` owns the steering and
follow-up drain, the undelivered text, and the stop policy.

Lifecycle: block check (streaming, key, spend cap) -> synchronous in-flight
latch -> token check -> refresh configuration -> automatic compaction -> token
check -> drain queues -> run -> drain queues -> consume one-shot overrides.

Invariants:

- One turn can start at a time per service.
- Stop drains the queues before it aborts (`AgentSteeringQueue.stop`). Every
  path that ends a run early (toolbar Stop, approval Stop, spend cap) uses it,
  so a queued message never drains into the next run.
- Steering re-checks the session token before it enqueues a message.
- A stale token never starts a turn and never appends to the new transcript.
- A turn does not run when compaction rewrote the saved session but the live
  transcript could not follow; `maybeCompact` returns that message instead of a
  service field holding it between turns.

## Compaction

Owner: `AgentCompactionRuntime` owns the single in-flight pass and summarizes.
`AgentConversationCompaction` owns the two flows (manual `/compact` with its
audit pair, automatic before a turn). `AgentSessionActions.commitCompaction`
lands the result.

Lifecycle: read the live transcript and capture the binding (path +
generation) -> summarize (no lock held) -> `commitCompaction` enqueues one
operation: guarded rewrite, install on the live agent, reload the persisted
transcript if the install fails -> notify.

Invariants:

- Persist first; replace the live agent second; both inside one queue
  operation, so no swap or rewind can slip between them.
- A swap, rewind, or other rewrite after the binding was captured fails the
  commit before it writes.
- A failed compaction never loses the pending prompt.
- One pass at a time; a manual pass never joins an automatic one (`busy`).
- The manual audit end event is recorded only when the conversation token is
  unchanged, so the pair stays in one session.
- The manual audit start event is captured against the session that began the
  pass. The append binds that file before it writes, so a swap during the write
  cannot land the start in the new session; the token check then refuses to run
  the pass. Pinned by `test/conversation-compaction.test.ts` (`keeps the start
  audit in the session that began the pass when a swap lands during its write`).

Closed in this round: the two staleness tokens (`sessionEpoch` and
`sessionGeneration`) are one; compaction recovery no longer loads outside the
swap queue; the compaction rewrite and install can no longer interleave with a
swap; `compactionRecoveryError` is gone.

## Approval

Owner: `AgentToolCallController` owns the turn-scoped stop latch (`stopTurn` /
`currentTurn`), the pending undo map, and the undo stack. `approval.ts` is the
single writer for the per-tool policy map. The approval modal owns one request in
the UI.

Invariants:

- One modal per tool request.
- Allow, deny, and stop are three distinct outcomes.
- A deny never stops the turn. Only Stop stops the turn.
- Remembered choices change settings only through `setPerToolApproval`.
- An approval that belongs to session A cannot apply to session B.

Fixed by #235: Stop is an explicit `stopped` flag on `UserApprovalChoice`. A deny
reason that matches the stop text no longer takes the stop path. Pinned by
`test/tool-call-controller.test.ts` (`does not stop the turn when a deny reuses
the stop text as its reason`).

Fixed: the stop latch is turn-scoped, not service-global. `stopTurn` names the
turn that was stopped, and `consumeStopRequested` returns true only while
`stopTurn === currentTurn`; `beginTurn` clears the old turn. Pinned by
`test/tool-call-controller.test.ts` (`latches a stopped approval once for the
turn`, `blocks sibling calls in the same batch after a stopped approval`, `does
not block the next turn after an unconsumed stop`).

Fixed: an approval is bound to its turn's abort signal. A session swap detaches
the old agent and aborts that signal, so the modal settles as a stopped denial;
closing the tab closes the modal and settles it as a denial. A decision that
arrives after the modal settled is ignored. Pinned by
`test/approval-modal.test.ts` (`closes and settles with a denial when the turn
aborts`, `ignores a late answer after its turn was aborted`, `settles as denied
when its tab closes`).

## MCP connection and auth

Owner: `McpHttpClient` owns `nextId`, `sessionId`, `initialized`, and the
protocol version. Each discovery, probe, and tool call creates a new client, so
connection state is per request. That is intentional: no stale connection state
is shared across sessions. `src/mcp/oauth.ts` owns the refresh flights, keyed by
the stable `id || url`, not by object identity. Token state lives on
`McpServerSettings.oauth`; the settings owner persists it.

Invariants:

- One refresh per server id. Two 401 responses must not rotate the same refresh
  token twice.
- A follower copies the leader's rotated tokens.
- A caller's abort cancels only that caller. It does not cancel the shared
  refresh or another live caller.
- A stale `invalid_grant` must not erase tokens that a newer refresh installed.
- No dedupe by object identity. Plugin MCP servers are cloned on each runtime
  load.

Fixed by #231: plugin server clones write refreshed tokens, known tools, and the
pending OAuth challenge back to `settings.plugins.mcpState`. A moved `mcp.json`
URL clears the old auth before the next load, and the settings probe callbacks
sync the changed server before saving.

Gap:

- The OAuth callback receiver lifecycle is separate from the settings owner.

Next: keep the per-request client. Make the stable server id the single owner for
token refresh and callback lifecycle.

## Settings

Owner: `SettingsStore` (`src/settings-store.ts`) holds the live
`AgenticChatSettings` object, serializes saves, and fans out change listeners.
`src/main.ts` keeps `plugin.settings` pointing at the same object and supplies
the persist callback (`saveData(settingsForStorage(...))`).

Write path: a caller either calls `settingsStore.update(mutator)` (mutate and
save once; return `false` to skip the save) or mutates an existing value and
calls `settingsStore.save()`. `plugin.saveSettings()` delegates to the owner, so
the injected callbacks in `agent/` and `plugins/` use the same path. The UI entry
points (`chat-view`, `slash/model`, `slash/session`, the settings tab) call the
owner. A refusing secret store makes the save throw; callers that catch that
today still catch it.

Change listeners: `settingsStore.onChange` runs only after a successful save,
never after a failed one. The mode broadcast is one listener
(`main.ts` `broadcastModeChange`): it repaints chat chrome only when
`settings.mode` changed since the last load or broadcast.

Secret slots: `SETTINGS_SECRET_SLOTS` names every top-level slot;
`MCP_SECRET_SLOTS` names the four MCP slots once, for both user servers and
plugin-owned state. One implementation hydrates from the secret store, writes to
it and strips plaintext from `data.json`, and migrates legacy plaintext. MCP
secret ids use `agentic-chat-mcp-<id>-<kind>`; ids are normalized (lowercase,
non-alphanumerics to `-`, long ids hashed to 64 chars).

| Slot | Runtime field | Secret id | Legacy plaintext | Stripped from data.json |
|---|---|---|---|---|
| OpenRouter API key | `openrouterApiKey` | `agentic-chat-openrouter-api-key` | `openrouterApiKey` | yes |
| OpenAI-compatible API key | `openaiCompatibleApiKey` | `agentic-chat-openai-compatible-api-key` | `openaiCompatibleApiKey` | yes |
| Web search key | `web.searchApiKey` | `agentic-chat-web-search-api-key` | `web.searchApiKey` | yes |
| Langfuse public key | `observability.langfusePublicKey` | `agentic-chat-langfuse-public-key` | `observability.langfusePublicKey` | yes |
| Langfuse secret key | `observability.langfuseSecretKey` | `agentic-chat-langfuse-secret-key` | `observability.langfuseSecretKey` | yes |
| Observability auth header | `observability.authHeaderValue` | `agentic-chat-observability-auth-header-value` | `observability.authHeaderValue` | yes |
| MCP auth header | `authHeaderValue` | `agentic-chat-mcp-<id>-auth-header-value` | `authHeaderValue` | yes |
| MCP OAuth client secret | `oauth.clientSecret` | `agentic-chat-mcp-<id>-oauth-client-secret` | `oauth.clientSecret` | yes |
| MCP OAuth access token | `oauth.accessToken` | `agentic-chat-mcp-<id>-oauth-access-token` | `oauth.accessToken` | yes |
| MCP OAuth refresh token | `oauth.refreshToken` | `agentic-chat-mcp-<id>-oauth-refresh-token` | `oauth.refreshToken` | yes |

Invariants:

- One save path. Every persisted read, write, strip, and migration uses the slot
  tables, so `data.json` and the secret-store keys keep their existing shape.
- A plaintext secret key is omitted from `data.json`, never written as `""`.
- A failed save does not notify listeners and does not broadcast the mode.
- `plugin.settings` and the owner hold the same object; a load swaps both.
- `mcp.json` owns plugin server shape; settings own client state. A refresh
  writes the changed state back through the owner.

## Semantic index writer

Owner: `bootstrapSemanticIndex` owns the write and its lease.
`SemanticIndexWorkflowController` owns the run and its abort controller.
`SemanticIndexLeaseRegistry` is the per-path arbiter; its
`IndexedDbSemanticLeaseStore` is the cross-window arbiter.
`bootstrapSemanticIndex` writes through `.tmp` and keeps `.bak`.
`readSemanticIndexFile` serves the backup and repairs a stale `running` status
on read.

Invariants:

- One writer per index path.
- The writer acquires the lease before its first write and releases it in
  `finally`.
- Every persisted batch checks that the lease is still owned and renews it.
- The lease TTL is 2 minutes. A live writer renews it on a timer every 30 s
  and clears the timer on release. A crashed or reloaded owner's lease lapses
  within the TTL, and a refused start reports the holder's age and the wait.
- A complete target is backed up before any replacement.
- An unreadable target is not replaced unless a complete backup exists.
- A read serves the last complete index when the target is missing or corrupt.
- A stale `running` status is reported as failed, not as a live run.

Fixed by #232: closing the view aborts its index run.

Fixed by #237: a shared IndexedDB lease serializes one path across windows. Keys
use the vault base path on desktop (identical in every window) and a stable
generated vault id on mobile, so two same-named vaults do not block each other. A crashed owner is recoverable after the TTL, and a lost renewal
flips `isOwned` to false before the next persisted batch. If the shared store is
unavailable, indexing fails closed instead of falling back to a single-window
writer.

Fixed by #249: `bootstrapSemanticIndex` acquires the lease itself and returns a
lease result the UI can render. The UI no longer acquires the lease, so a direct
caller cannot write without it.

Gaps:

- The plugin folder can hold `index.json`, `index.json.bak`, and
  `index.json.tmp` at the same time.

Next: define cleanup for stale `.tmp` and `.bak` files.

## Plugin install

Owner: `PluginService` (`src/plugins/service.ts`) owns the catalog cache, its
invalidation listeners, the single-flight reload, the retained-backup flag, and
the one lock that orders install transactions and the recovery sweep. It
delegates and holds no other state:

| Concern | Module | State |
|---|---|---|
| Vault I/O confined to the plugins folder | `PluginVault` (`plugin-vault.ts`) | none |
| Stage, backup, and rename transaction | `installPackage` (`import/install.ts`) | vault folders |
| Crash recovery of `.importing-*` folders | `sweepImportStages` (`import-sweep.ts`) | none; returns the retained-backup outcome |
| Packages the plugin writes (builtins, my-skills, legacy-skills, MCP package, scaffolded skill) | `materialize.ts` | none |
| Plugin-owned settings (`plugins.enabled`, `plugins.sources`, `plugins.mcpState`, plugin `mcp.servers`) | `plugin-settings-records.ts` | none; mutates settings, the service saves |

Lifecycle of a reload: take the lock -> sweep -> release -> scan -> prune
orphan settings unless a backup is retained -> save if pruned.

Lifecycle of an install: validate native files -> take the lock -> stage,
back up, rename -> release -> record source and MCP state -> save once ->
invalidate.

Invariants:

- Write the manifest last inside the stage. A crash before it leaves an invisible
  stage, not a broken package.
- Never delete the only package copy.
- A backup restores when the target is missing, or replaces an empty target.
- A target with a readable manifest owns its name; the backup is then removable.
- A failed rename restores the backup.
- The writer never removes a path outside the plugins folder.
- A sweep waits for an in-flight install; two installs cannot move the same
  backup. A rejected operation clears the chain for the next one.
- Reload is single-flight; a rejected reload clears the in-flight promise.
- An install saves settings exactly once, so a changed source label persists
  even when every MCP server state already existed.

Pinned: `test/plugins-service-import.test.ts` (`does not sweep the stage of an
in-flight install`, `runs a later install after a rejected install`) proves the
shared lock and the cleared chain. `test/plugins-service.test.ts` (`runs one
import sweep for concurrent reloads`, `retries after a failed reload instead of
leaving it in flight`) proves the single-flight reload.

Gap:

- Settings prune runs after the sweep and depends on the retained-backup flag.

## Source import and frontmatter

Owner: `SourceArtifactCache` (`src/retrieval/source-ingest.ts`) owns one
importer's in-memory artifacts by dedup key, the lookup of an artifact an
earlier session persisted, and the write. `sourceDedupKeys` is the only place
that derives dedup keys, current (SHA-256) and legacy (FNV-1a), from
`${kind}:${normalized source}` and the trimmed text. The web
(`source-artifacts.ts`), PDF (`pdf-ingest.ts`), and document
(`document-ingest.ts`) importers own only extraction and their provenance
frontmatter.

`splitFrontmatter` (`src/vault/frontmatter.ts`) is the one frontmatter
splitter for skills, the plugin importer, graph tools, and retrieval. The flat
`parseFrontmatterFields` reads the provenance block of source artifacts.

Invariants:

- A persisted artifact keeps deduping: the current and legacy keys are derived
  the same way for every importer and every release.
- `import_pdf` and `import_document` share one PDF import path and one cache,
  so the same PDF imported through either tool is one artifact.

Gap:

- `skillNameFromDoc` (`src/plugins/import/shared.ts`) still reads `name:` with
  its own regex. It strips every quote character, so moving it to the shared
  splitter would change results for quoted names.

## Order and reason

| Plan | GitHub PR | Scope | Status |
|---|---|---|---|
| 9 | #229 | Session token stability | merged |
| 10 | #230 | Manual compaction reports busy | merged |
| 11 | #231 | Plugin MCP auth persistence | merged |
| 12 | #232 | Close-view cancellation and single-flight reload | merged |

The plan order put the session token first because turn, compaction, and approval
ownership depend on it. The remaining gaps above do not have a scheduled PR. Do
not add a new checker for them; move the writer into the owner first.

## Rules for the structural PRs

1. Move the writer into the owner. Do not add a second checker next to the old
   one.
2. Keep one staleness token. Remove the duplicate path and epoch checks only
   after the owner covers every caller.
3. State that can outlive a turn carries a turn id and a session token.
4. Every ownership move needs a witness that fails on the parent.
5. Update this file in the same PR. An owner that exists only in code is not a
   map.
