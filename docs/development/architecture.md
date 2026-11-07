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
| Active session pointer, transcript, generation | `ObsidianSessionManager` | session JSONL; generation in memory |
| Session swap sequence | `AgentSessionSwapQueue` in `AgentSessionActions` | memory |
| Session-local service state | `AgentSessionLocalState` | memory |
| One prompt turn | `AgentPromptTurnRuntime` plus pi `Agent` | memory |
| Redirect delivery | `AgentService.pendingRedirects` | memory |
| Compaction pass | `AgentCompactionRuntime.inFlight` | memory plus session JSONL |
| Approval decision and stop flag | `AgentToolCallController` | memory, plus settings for remembered choices |
| MCP connection state | `McpHttpClient` per request | memory |
| MCP OAuth refresh | `refreshFlights` in `src/mcp/oauth.ts` | memory plus `McpServerSettings.oauth` |
| Semantic index writer | `SemanticIndexLeaseRegistry` and `SemanticIndexWorkflowController` | `index.json`, `index.json.bak` |
| Plugin install | `installPackage` transaction | vault folders |

## Active session

Owner: `ObsidianSessionManager` owns `sessionFile`, `sessionGeneration`, the
entry log, append, and rewrite. `AgentActiveSessionRuntime` owns the cached
`SessionInfo` snapshot. `AgentSessionActions` owns the only swap queue and the
`sessionEpoch` token.

Invariants:

- Only `AgentSessionActions` moves the active pointer, and only inside the swap
  queue.
- Every guarded rewrite carries `expectedPath` and `expectedGeneration`. A
  stale rewrite fails; it never writes into another session.
- An append captures the active file before it writes. After a swap, the append
  lands in that old file and never in the new one. It does not throw.
- The service prepares resources before it detaches the agent, and detaches
  before the pointer moves. A late event from the old agent must not land in the
  new file.
- A failed swap leaves the previous live agent, or a recoverable session. It
  never leaves two live agents.
- A UI send carries `path:epoch`. A send whose token changed must fail.

Gaps:

- Two staleness guards exist: `sessionEpoch` in `AgentSessionActions` and
  `sessionGeneration` in `ObsidianSessionManager`.
- An append writes to the captured old file without an error. Only a rewrite
  rejects a stale target, so a caller cannot tell that an append missed the new
  session.
- `AgentService.recoverCompactedSession` loads a session outside the swap queue.
- `AgentService.compactNow` and `maybeCompact` guard with tokens but do not queue
  behind a swap.
- The composer's queued-prompt reset lives in `SessionActivationCoordinator`, not
  in the session runtime that owns the swap.

Fixed by #229: a failed resource reload no longer invalidates the token before
the swap commits.

Next: one runtime owns path, generation, agent, swap queue, and the queued-prompt
reset. Duplicate path and epoch checks are removed only after the owner covers
every caller.

## Turn

Owner: `AgentPromptTurnRuntime` owns `inFlight` and the idle waiters. The pi
`Agent` owns `isStreaming` and its steer and follow-up queues. `AgentService`
owns `pendingRedirects` and the single redirect worker.

Invariants:

- One turn can start at a time per service.
- Stop clears the steer and follow-up queues before it aborts. A queued message
  must not drain into the next run.
- Redirects are delivered in order. Each redirect re-checks the session token
  after every wait.
- A stale token never starts a turn and never appends to the new transcript.
- Starting a session swap disarms the composer's queued prompt before the swap
  begins.

Fixed by #239: an e2e starts a turn in two tabs, stops one, and proves the other
still finishes.

Gaps:

- Stop policy is spread across `AgentService.abort`, `stopAgent`, the redirect
  worker, the spend cap, and the approval controller's `onStopRequested`.
- `stopRequested` in `AgentToolCallController` is a service-global boolean, not
  tied to a turn id.
- `compactionRecoveryError` is a service field, not tied to a session.

Next: one runtime owns stop, redirect, steer, follow-up, and turn recovery.

## Compaction

Owner: `AgentCompactionRuntime` owns the single in-flight pass.
`maybeCompactAgentTranscript` owns the order persist then replace.
`ObsidianSessionManager.rewriteMessages` owns the guarded rewrite. The caller
owns replacement of the live agent and recovery.

Invariants:

- Persist first; replace the live agent second.
- The rewrite carries the path and generation captured before summarization.
- A rewrite stages a same-folder temp file and renames it over the session, so a
  crash leaves the old transcript or the new one, never a truncated file.
- A failed compaction never loses the pending prompt.
- One compaction pass runs at a time.

Fixed by #230: a forced/manual caller no longer joins an automatic pass. It
returns `busy` instead of silently dropping its instructions.

Gaps:

- `compactNow` records the audit `start` before it checks the session token. A
  swap during that write can put the start event in a different session.
- `recoverCompactedSession` replaces the agent outside the swap queue.

Next: compaction becomes a phase of the turn runtime, with one owner for the
pass, the audit pair, and recovery.

## Approval

Owner: `AgentToolCallController` owns `stopRequested`, the pending undo map, and
the undo stack. `approval.ts` is the single writer for the per-tool policy map.
The approval modal owns one request in the UI.

Invariants:

- One modal per tool request.
- Allow, deny, and stop are three distinct outcomes.
- A deny never stops the turn. Only Stop stops the turn.
- Remembered choices change settings only through `setPerToolApproval`.
- An approval that belongs to session A cannot apply to session B.

Fixed by #235: Stop is an explicit `stopped` flag on `UserApprovalChoice`. A deny
reason that matches the stop text no longer takes the stop path.

Gaps:

- `stopRequested` is service-global and cleared at the next turn start. It is not
  tied to the request or turn that set it.
- `ToolApprovalRequest` carries a display label, not a session token. A modal can
  outlive the session it belongs to.

Next: tie the stop latch and the approval request to the turn and session token.

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

Owner: `installPackage` owns the stage, backup, and rename transaction.
`PluginService` owns the cache, the startup sweep, and the retained-backup flag.
The loader skips every `.importing-*` folder.

Invariants:

- Write the manifest last inside the stage. A crash before it leaves an invisible
  stage, not a broken package.
- Never delete the only package copy.
- A backup restores when the target is missing, or replaces an empty target.
- A target with a readable manifest owns its name; the backup is then removable.
- A failed rename restores the backup.

Fixed by #232: `PluginService.reload` is single-flight, so concurrent reloads
share one import sweep and one load. A rejected reload clears the in-flight
promise for the next call.

Fixed by #236: install transactions and the recovery sweep share one maintenance
lock. A sweep waits for an in-flight install, and two installs cannot move the
same backup. A rejected operation clears the chain for the next one.

Gap:

- Settings prune runs after the sweep and depends on the retained-backup flag.

Next: define the order between sweep, install, and settings prune.

## Unowned today

These items have no single owner. Do not add a new check for them; move the
writer.

| Item | Risk | Target |
|---|---|---|
| Approval stop reason | A deny with the stop text stops the turn | Unowned follow-up |
| Compaction audit start after swap | Audit entries land in the wrong session | Unowned follow-up |
| Compaction recovery outside swap queue | Recovery can overwrite a newer session | Unowned follow-up |
| Plugin sweep vs install race | A sweep and an install move the same stage | Unowned follow-up |

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
