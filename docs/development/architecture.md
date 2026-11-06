# Architecture: one owner per state

Status: design input for PRs 9-12. Update this file when ownership moves.

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
| Active session pointer, transcript, generation | `ObsidianSessionManager` | session JSONL |
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
- Every write to a chosen session carries `expectedPath` and
  `expectedGeneration`. A stale write fails; it never writes into another
  session.
- The service prepares resources before it detaches the agent, and detaches
  before the pointer moves. A late event from the old agent must not land in the
  new file.
- A failed swap leaves the previous live agent, or a recoverable session. It
  never leaves two live agents.
- A UI send carries `path:epoch`. A send whose token changed must fail.

Gaps:

- Two staleness guards exist: `sessionEpoch` in `AgentSessionActions` and
  `sessionGeneration` in `ObsidianSessionManager`.
- `AgentService.recoverCompactedSession` loads a session outside the swap queue.
- `AgentService.compactNow` and `maybeCompact` guard with tokens but do not queue
  behind a swap.
- The composer's queued-prompt reset lives in `SessionActivationCoordinator`, not
  in the session runtime that owns the swap.

Target: PR 9. One runtime owns path, generation, agent, swap queue, and the
queued-prompt reset. Duplicate path and epoch checks are removed only after the
owner covers every caller.

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
- A stale token never starts a turn and never appends to a transcript.
- Starting a session swap disarms the composer's queued prompt before the swap
  begins.

Gaps:

- Stop policy is spread across `AgentService.abort`, `stopAgent`, the redirect
  worker, the spend cap, and the approval controller's `onStopRequested`.
- `stopRequested` in `AgentToolCallController` is a service-global boolean, not
  tied to a turn id.
- `compactionRecoveryError` is a service field, not tied to a session.
- Two-tab Stop has no e2e that proves only the active tab aborts.

Target: PR 10. One runtime owns stop, redirect, steer, follow-up, and turn
recovery.

## Compaction

Owner: `AgentCompactionRuntime` owns the single in-flight pass.
`maybeCompactAgentTranscript` owns the order persist then replace.
`ObsidianSessionManager.rewriteMessages` owns the guarded rewrite. The caller
owns replacement of the live agent and recovery.

Invariants:

- Persist first; replace the live agent second.
- The rewrite carries the path and generation captured before summarization.
- A failed compaction never loses the pending prompt.
- One compaction pass runs at a time.

Gaps:

- A second caller joins `inFlight` and its custom instructions are ignored. A
  manual `/compact <instructions>` can silently run the auto-compaction pass.
- `compactNow` records the audit `start` before it checks the session token. A
  swap during that write can put the start event in a different session.
- `recoverCompactedSession` replaces the agent outside the swap queue.
- The joined caller cannot tell which transcript the in-flight pass compacted.

Target: PR 10. Compaction becomes a phase of the turn runtime, with one owner
for the pass, the audit pair, and recovery.

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

Gaps:

- Stop is inferred from the deny reason string: a deny reason equal to
  `STOPPED_APPROVAL_REASON` takes the stop path.
- `stopRequested` is service-global and cleared at the next turn start. It is not
  tied to the request or turn that set it.
- `ToolApprovalRequest` carries a display label, not a session token. A modal can
  outlive the session it belongs to.

Target: PR 10. Approval returns an explicit outcome (`allow`, `deny`, `stop`)
and carries the turn and session token.

## MCP connection and auth

Owner: `McpHttpClient` owns `nextId`, `sessionId`, `initialized`, and the
protocol version. Each discovery, probe, and tool call creates a new client, so
connection state is per request. `src/mcp/oauth.ts` owns the refresh flights,
keyed by the stable `id || url`, not by object identity. Token state lives on
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

Gaps:

- Connection state is not shared across requests, so every call initializes
  again and no session id is reused.
- Auth state is mutable on settings objects that can be cloned per runtime load.
- The OAuth callback receiver lifecycle is separate from the settings owner.

Target: PR 11. Keep the per-request client, make the stable server id the only
auth owner key, and remove the remaining object-identity assumptions.

## Semantic index writer

Owner: `SemanticIndexWorkflowController` owns the run and its abort controller.
`SemanticIndexLeaseRegistry` owns the per-path lease. `bootstrapSemanticIndex`
writes through `.tmp` and keeps `.bak`. `readSemanticIndexFile` serves the backup
and repairs a stale `running` status on read.

Invariants:

- One writer per index path.
- Every persisted batch checks that the lease is still owned.
- A complete target is backed up before any replacement.
- An unreadable target is not replaced unless a complete backup exists.
- A read serves the last complete index when the target is missing or corrupt.
- A stale `running` status is reported as failed, not as a live run.

Gaps:

- The lease registry is in memory and per window. Two Obsidian windows do not
  share it.
- Closing the view does not abort the run; the controller belongs to the view.
- The lease is acquired by the UI controller, not by the writer itself.
- The plugin folder can hold `index.json`, `index.json.bak`, and
  `index.json.tmp` at the same time.

Target: PR 12. Durable writer ownership, a cross-window lease, and close-view
cancellation.

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

Gaps:

- `PluginService.reload` can run more than once at a time, so
  `sweepImportStages` is not single-flight.
- A sweep and an install can race on the same stage or backup name.
- Settings prune runs after the sweep and depends on the retained-backup flag.

Target: PR 12. One install transaction owner, with a single-flight sweep and a
defined order between sweep, install, and settings prune.

## Unowned today

These items have no single owner. Do not add a new check for them; move the
writer.

| Item | Risk | Target |
|---|---|---|
| Cross-window semantic lease | Two windows write the same index | PR 12 |
| Close-view cancellation | An index run outlives its view | PR 12 |
| Approval stop reason | A deny with the stop text stops the turn | PR 10 |
| Compaction join instructions | A manual `/compact` silently loses its instructions | PR 10 |
| Compaction audit start after swap | Audit entries land in the wrong session | PR 10 |
| Compaction recovery outside swap queue | Recovery can overwrite a newer session | PR 10 |
| Concurrent plugin sweeps | Two sweeps move the same backup | PR 12 |
| Two-tab Stop e2e | Only unit proof exists for per-tab stop | PR 9 |

## Order and reason

| PR | Scope | Depends on |
|---|---|---|
| 9 | Session ownership | none |
| 10 | Turn and compaction ownership | PR 9 (session token) |
| 11 | MCP ownership | none |
| 12 | Semantic and plugin ownership | none |

PR 9 comes first because the session token is the base for turn, compaction, and
approval ownership. PR 10 depends on a single token. PR 11 and PR 12 are
independent, but they follow the same rule: move the writer into the owner.

## Rules for the structural PRs

1. Move the writer into the owner. Do not add a second checker next to the old
   one.
2. Keep one staleness token. Remove the duplicate path and epoch checks only
   after the owner covers every caller.
3. State that can outlive a turn carries a turn id and a session token.
4. Every ownership move needs a witness that fails on the parent.
5. Update this file in the same PR. An owner that exists only in code is not a
   map.
