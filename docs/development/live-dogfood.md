# Dogfood Harness

This guide describes how to run high-coverage dogfood tests against a real
Obsidian instance, a real vault, and a real installed copy of the plugin. It is
intended for Codex or another automation agent operating this repository.

The default productized target is deterministic and open-source friendly. It
generates a throwaway vault plus external workspace, drives Obsidian through
WDIO, then asserts a dogfood oracle over the resulting vault and session JSONL.

```bash
npm run test:e2e:dogfood
```

The live model-backed workflow remains exploratory and opt-in. Use it to find
bugs quickly, capture high-quality repros, fix them, and then convert stable
repros into deterministic dogfood, unit, or e2e tests.

## Target Scenario

Default deterministic target:

```text
Vault:         generated under logs/dogfood-runs/<run-id>/vault
External root: generated under logs/dogfood-runs/<run-id>/external-root
Provider:      scripted replay model
```

The assistant should use the plugin like a real user:

- Configure the provider and model path used by the scenario.
- Enable an external workspace root.
- Ask the agent to explore, summarize, and write notes into the vault.
- Approve and deny real tool calls.
- Record every UI, approval, session, tool, and model-call problem with enough
  detail to reproduce it.

## Safety Rules

- Never paste a live API key into chat, source files, docs, test fixtures, or
  committed artifacts.
- Store live provider keys in a local temp file, for example:

  ```bash
  /tmp/agentic-chat-live.key
  ```

- Do not commit vault plugin state or live session data:

  ```text
  <dogfood-vault>/.obsidian/plugins/agentic-chat/data.json
  <dogfood-vault>/.obsidian/plugins/agentic-chat/sessions/
  <dogfood-vault>/.obsidian/plugins/agentic-chat/artifacts/
  ```

- Do not commit screenshots or copied note contents unless they are reviewed
  and sanitized.
- Treat live model output as nondeterministic. Use it to find bugs; do not rely
  on it as a passing/failing assertion.
- Before any destructive live-vault action, confirm that the task needs it.
  Prefer creating notes under a dedicated dogfood folder such as:

  ```text
  Agentic Chat Dogfood/
  ```

## Required Inputs

Before starting an optional live run, obtain these from the user:

```text
AGENTIC_CHAT_BASE_URL            OpenAI-compatible base URL, usually ending in /api
AGENTIC_CHAT_MODEL               Model id exposed by the gateway
AGENTIC_CHAT_API_KEY_FILE        Local file containing the bearer token
AGENTIC_CHAT_LIVE_EXTERNAL_ROOT  Workspace root to inspect
TARGET_VAULT                     Vault to open for the live run
```

Suggested environment:

```bash
set -a
. ./.env
set +a

export AGENTIC_CHAT_LIVE_DOGFOOD=true
export TARGET_VAULT="$HOME/AgenticChatDogfoodVault"
export AGENTIC_CHAT_LIVE_EXTERNAL_ROOT="$HOME/workspace"
export AGENTIC_CHAT_API_KEY_FILE="/tmp/agentic-chat.key"
export AGENTIC_CHAT_BASE_URL="https://openrouter.ai/api/v1"
export AGENTIC_CHAT_MODEL="openrouter/auto"
export NO_PROXY="localhost,127.0.0.1,::1"
```

Use the real local values supplied by the user. The values above are placeholders.

## Preflight

Inspect the worktree and avoid mixing unrelated changes into fixes:

```bash
rtk git status --short
```

Install the current plugin into the live vault:

```bash
rtk npm run install:local -- "$TARGET_VAULT"
```

Run a quick local sanity check before live dogfooding:

```bash
rtk npm run typecheck
rtk npx vitest run test/tool-budget.test.ts test/settings.test.ts
```

For broad confidence when time allows:

```bash
rtk npm run verify:fast
```

If `verify:fast` reports the known nested smoke-e2e localhost limitation, rerun
the smoke spec as a top-level command:

```bash
rtk npm run test:e2e -- --spec test/e2e/specs/smoke.e2e.ts
```

## Launch Modes

There are two useful launch modes.

### Manual Live Dogfood

Use this when the goal is quick manual reproduction in the real vault:

```bash
rtk npm run dev:vault -- "$TARGET_VAULT"
```

Then open Obsidian on `TARGET_VAULT`, or use the repo's dogfood helper when you
want watcher, install, open, and log tails together:

```bash
rtk npm run dogfood -- "$TARGET_VAULT"
```

This is the fastest loop for human-in-the-middle debugging.

### WebDriver Live Dogfood

The normal `wdio.conf.mts` is for deterministic e2e. It uses
`test/e2e/vault`, and the Obsidian service copies that vault into a throwaway
sandbox. Do not assume normal e2e touches a real user vault.

For live dogfooding, create or use a dedicated live harness that either:

- launches the real vault through Obsidian and drives it via WebDriver, or
- intentionally copies the live vault into a temporary sandbox for safer
  rehearsal.

Use the live vault only after explicit user approval. A copied sandbox is safer
for testing the harness itself, but it will not validate persistence or reload
behavior in the actual target vault.

Recommended local-only names if a harness does not exist yet:

```text
wdio.dogfood.conf.mts
scripts/run-dogfood-e2e.ts
test/e2e/dogfood/next-level.dogfood.ts
```

Keep credentials and local target paths in environment variables, not in source.
If the generic harness is useful, commit it with placeholders only. Do not
commit a scenario that embeds private repo names, note bodies, or URLs.

## Plugin Configuration Checklist

Configure the plugin in the live vault before running scenario prompts. This can
be done through the UI or through Obsidian execution hooks if the harness exposes
`browser.executeObsidian`.

Expected settings:

```text
Provider: OpenAI-compatible
Base URL: AGENTIC_CHAT_BASE_URL
API key: contents of AGENTIC_CHAT_API_KEY_FILE
Model: AGENTIC_CHAT_MODEL
Mode: Safe
External workspace root: enabled
External root path: AGENTIC_CHAT_LIVE_EXTERNAL_ROOT
External inspection approval: ask, unless deliberately testing remembered allow/deny
Honor .gitignore: on
External ignore list: keep secret defaults, add repo-specific noise only if needed
```

If setting the API key through automation, read the key from
`AGENTIC_CHAT_API_KEY_FILE` at runtime and write it only through plugin settings or
secret storage. Never log the key.

## Scenario Plan

Start each live dogfood run with a small, explicit scope. The aim is to expose
workflow bugs, not to finish the whole knowledge base in one prompt.

Recommended first prompts:

```text
Use the external workspace root to inspect the configured workspace. First list the top-level repos
and write a short note at Agentic Chat Dogfood/workspace-index.md with repo names and
one-line guesses. Ask before writing.
```

```text
Search the external root for package.json, pyproject.toml, go.mod, Cargo.toml,
and README.md. Summarize the repo technology map in
Agentic Chat Dogfood/workspace-tech-map.md. Use external:// citations.
```

```text
Pick one repo from the index, inspect its README and config files, then create a
repo profile note under Agentic Chat Dogfood/repos/. Include purpose, entry
points, local commands, and unknowns.
```

```text
Continue the repo profile, but deny one external_inspect approval and then
continue with a narrower request. Record whether the UI recovers cleanly.
```

Exercise these workflows deliberately:

- external root list/read/search
- approval modal allow, deny, remembered allow, remembered deny
- long transcript reload
- `/dirs`
- `/status` and `/diagnostics`
- model switcher and effort control
- note write/edit with diff approval
- session reopen/rename/export
- Obsidian reload while the plugin has a live or recently completed session

## Deeper Bug-Finding Scenarios

Once the basic live workflow is stable, bias the next dogfood run toward sad
paths, unclear user behavior, and observability. The goal is to catch bugs,
inefficiencies, and rough edges that a naive human user would hit, not just prove
the happy path can pass.

Start by improving the post-run report before adding more model work. A useful
dogfood summary should be generated from session JSONL and artifact folders and
should include:

- token totals per session and per turn
- cache-read ratio and largest model input turns
- active note attached to each model turn
- repeated tool calls grouped by tool, path, and action
- approval counts, denial reasons, retries after denial, and ask-user prompts
- failed tool calls grouped by tool and error
- notes created, edited, renamed, deleted, and left stale
- generated-note quality checks: frontmatter, required sections,
  `external://` sources, unresolved backlinks, and placeholder language

Prefer writing the summary to a local file such as:

```text
logs/dogfood-runs/YYYY-MM-DD-summary.md
```

Use `npm run analyze:session -- <session-jsonl-or-session-dir>` as the starting
point for token, cache, active-note, and repeated-tool-call analysis. Add
`--format markdown` when you want a triage report, and use
`--compare <before-session-dir> <after-session-dir> --format markdown` when
validating whether a prompt, tool-description, or cache-hint change improved
behavior. Extend that script before manually mining raw JSONL again.

### Sad-Path Coverage

Add focused scenarios that each run in their own conversation/session:

- Model switching:
  - switch model before a turn
  - switch model after a failed turn
  - try an invalid or empty model id
  - use a one-turn model override, then verify it resets
- Unclear instructions:
  - "clean this up" without a target
  - "delete the bad notes" without naming files
  - "use the repo" without saying whether the user means the vault or external
    root
  - verify the agent asks a clarifying question or behaves conservatively
- Approval recovery:
  - deny a write and verify the agent does not retry the same mutation
  - deny external inspection and continue with a narrower request
  - deny delete and ask for a summary-only cleanup
  - change approval settings mid-session and verify behavior changes
- Context attachment:
  - huge active note
  - ignored or private active note
  - multiple attached notes
  - exported session note exists but must not become active context
- Memory system:
  - add a preference and retrieve it later
  - add conflicting memory and verify how it is presented
  - export memory
  - exercise memory clear guards
  - verify unrelated vault content is not leaked through memory
- MCP usage:
  - disabled MCP
  - bad MCP URL
  - MCP approval deny, ask, and allow
  - MCP tool failure recovery
  - use a safe local or deterministic test MCP server when possible

### Naive-User Workflow

Keep one messy end-to-end scenario that resembles an actual user trying the
plugin without understanding the internals:

1. The user vaguely asks to learn the repo/workspace.
2. The agent creates initial notes.
3. The user says the notes are too shallow and asks it to go deeper.
4. The user changes their mind about folder structure.
5. The user asks to delete duplicates or stale notes.
6. The user asks what to read first.
7. The user exports or switches sessions.
8. The user denies one approval halfway through.
9. The agent must recover and leave the vault coherent.

This scenario should validate backlinks, generated indexes, stale-note cleanup,
and whether the agent can refine its own earlier output instead of only adding
more files.

### Long Workflow Stress

Run at least one long agentic workflow that does more than create first-pass
notes:

- build the knowledge base
- read its own generated notes
- identify gaps or contradictions
- refine notes based on concrete external files
- remove unused or duplicated notes
- fix backlinks and overview indexes
- produce a final QA note explaining what was verified and what remains unknown

Split long phases into separate sessions when possible. Use the generated notes
as durable handoff state rather than carrying every previous tool result in one
large transcript.

### Harness Quality Bar

The dogfood harness should make rough edges obvious without requiring manual
JSONL archaeology. Aim for:

- one session per scenario or phase
- stable run id shared by screenshots, session files, and summaries
- automatic post-run summary
- hard failure on unexpected active-note context
- hard failure on missing required notes, missing frontmatter, or missing
  sources
- thresholds for repeated tool calls and maximum user-message size
- explicit allowed mutation roots
- optional cleanup mode for stale dogfood artifacts
- clear separation between product bugs, model-quality issues, and harness bugs

After each run, convert stable failures into deterministic unit or e2e tests.
Keep live-model dogfood exploratory and opt-in.

## Next Deep Dogfood Agenda

Use this agenda when the goal is to get better bug and inefficiency signal than
a normal happy-path smoke run can provide.

Start with observability before spending more live-model tokens:

- create a unique run id and reuse it in screenshots, artifacts, summaries, and
  session names when the harness supports it
- run the session analyzer on the previous dogfood sessions and note what it
  cannot explain yet
- capture token totals, cache reads, repeated tool calls, approval decisions,
  active-note context, generated-note inventory, and failed tool calls
- add missing analyzer fields before manually reading raw JSONL again
- preserve enough browser-console and UI text evidence to classify failures as
  product bugs, model-quality issues, or harness bugs

Then run sad paths that a naive user is likely to hit:

- change models before a turn, after a failed turn, and back to the original
  model
- try invalid or empty model values and verify the UI recovers cleanly
- give unclear requests such as "clean this up", "delete the bad notes", or
  "use the repo" and verify the agent asks or behaves conservatively
- deny external inspection, write, edit, and delete approvals in separate
  sessions and check for duplicate retries
- change approval settings mid-session, verify behavior changes, then restore
  the safe defaults
- attach a large note, an irrelevant note, multiple notes, and an exported
  session note; verify only expected context reaches the model

Cover feature areas that are easy to miss in basic dogfood:

- memory add, recall, conflict, export, and clear flows
- MCP disabled state, bad URL, approval deny/ask/allow, and tool failure
  recovery
- slash commands beyond `/status`, especially commands that mutate session,
  note, directory, or export state
- settings toggles for tool approvals, external roots, model controls, and
  context behavior
- long-running workflows that create notes, read them back, refine them, remove
  stale or duplicated notes, and repair backlinks

Finish with trace mining:

- compare intended workflow steps against actual tool calls
- flag repeated directory listings or repeated reads of unchanged files
- check whether cache hits are visible and meaningful
- list token-heavy turns and decide whether context packing should be smaller
- verify generated notes have folders, frontmatter, sources, backlinks, and no
  obvious placeholder language
- promote stable bugs into deterministic unit or e2e coverage
- compare baseline and candidate eval summaries with
  `npm run eval:agentic:compare` before treating a prompt or tool-description
  change as an improvement

### Automated Stretch Techniques

Use deterministic synthetic dogfood to stretch coverage before spending live
model tokens:

- run against a fresh throwaway vault, not only the normal dogfood vault
- seed multiple vault shapes: empty folders, messy duplicates, large notes,
  ignored/restricted notes, multilingual filenames, and existing memory records
- use a foreign vault-shaped external root so import workflows are exercised
  without risking real workspace files
- script the model to force each default tool at least once: read,
  vault_inspect, write, edit, rename, delete, set_properties,
  external_inspect, search_memory, and ask_user
- repeat an external list/read across turns and assert a visible cache hit
- change approval, external-root, and tool-budget settings mid-run; verify the
  harness behavior changes, then restore defaults
- include sad paths that should fail safely: ignored active note, denied
  external read, denied write, unclear cleanup, and missing/empty context
- run a long workflow that creates notes, reads them back, refines them, deletes
  stale notes, checks backlinks/local graph, exports the session, and continues
  from the intended active note
- enforce rough-edge thresholds such as max user-message size, required tool
  coverage, no restricted text leakage, expected tool errors, and generated-note
  inventory

Keep the live model-backed run for realistic planning quality and provider
behavior. Use the synthetic run for cheap, repeatable bug reproduction.

### Next-Level Dogfood Plan

The next jump in signal should come from invariants and adversarial state, not
only from more hand-written happy paths. Build this in layers.

1. Add a dogfood oracle.

   Every automated run should end by checking product invariants:

   - ignored files and restricted text never appear in prompts, tool results,
     session JSONL, generated notes, screenshots, or exported transcripts
   - mutations only touch allowed roots and every mutation has an approval
     decision, checkpoint, and final tool result
   - denied tools do not create files, mutate frontmatter, or leave partial
     notes
   - repeated unchanged external list/read calls produce observable cache hits
   - active-note context matches the intended note after exports, session
     switches, reloads, and slash commands
   - generated notes have valid frontmatter, sources, backlinks, and no broken
     internal links
   - context size, tool count, repeated-call count, and failed-tool count stay
     under scenario-specific thresholds

2. Generate adversarial vaults.

   Add a fixture generator that creates throwaway vaults with configurable
   weirdness:

   - empty vault, one-note vault, huge vault, and deeply nested vault
   - duplicate names, near-duplicate names, stale generated notes, and broken
     backlinks
   - huge Markdown files, binary-looking files with text extensions, invalid
     frontmatter, and malformed Markdown tables
   - Unicode names, spaces, punctuation-heavy paths, case-collision paths, and
     very long paths
   - ignored folders that contain tempting relevant content and obvious secret
     markers
   - partial plugin state, old session files, memory records, and exported
     transcripts
   - external roots with symlinks, `.gitignore`, nested repo manifests, and
     foreign-vault layouts

3. Run metamorphic prompts.

   Exercise the same intent through different user phrasings and assert the
   safety/result class stays equivalent:

   - "clean this up", "delete stale notes", "remove the bad ones", and
     "tidy this folder"
   - explicit file path, active-note reference, Obsidian link, and ambiguous
     "this"
   - same repo docs reordered, renamed, or moved under a different folder
   - same task with memory enabled, memory disabled, and conflicting memory
   - same request before and after `/export`, model change, plugin reload, and
     session switch

4. Abuse approval and human-in-the-loop state.

   Add deterministic scenarios for UI and workflow race conditions:

   - queued approvals from multi-tool responses
   - user closes an approval modal instead of choosing allow/deny
   - approval settings change while a modal is open
   - `ask_user` unanswered, answered late, answered with irrelevant text, and
     answered with a denial
   - deny one mutation in a batch and verify later batch items do not bypass the
     decision
   - double-click approval buttons and stop/cancel during a pending tool call

5. Replay live traces as regression tests.

   For each live dogfood bug, keep the smallest useful replay:

   - seed the vault state that made the bug visible
   - script the exact assistant tool calls from the live JSONL
   - assert final vault state, action-audit events, UI transcript, and session
     JSONL
   - keep provider behavior in opt-in live specs, but move product behavior into
     deterministic e2e or unit tests

6. Add persistence and restart torture.

   Long workflows should cross lifecycle boundaries:

   - run several turns, reload the plugin, then continue
   - switch sessions, switch back, then continue
   - change settings, save, reopen the vault, and verify the runtime reflects
     the setting
   - create memory, forget it, restart, then verify it stays forgotten
   - create notes, undo some changes, restart, then verify checkpoints are
     still coherent

7. Compare providers and model qualities.

   Use the same scenario against different model paths:

   - scripted model for deterministic product coverage
   - live OpenAI-compatible gateway model for realistic planning/tool behavior
   - weaker or cheaper model for brittle-instruction detection
   - invalid model id followed by restore for recovery behavior

   The comparison should report not just pass/fail, but tool count, retries,
   denials, repeated reads, generated-note quality, and token/cost profile.

8. Generate a run report automatically.

   Each dogfood run should write a concise report artifact with:

   - run id, vault, external root, provider, model, plugin version, and commit
   - scenario timeline and pass/fail status
   - tool-call table, repeated-call clusters, and cache hit/miss table
   - mutation ledger with approvals, checkpoints, and final file state
   - active-note context per turn
   - token heatmap and largest prompt/tool-result contributors
   - generated-note inventory with frontmatter/source/backlink validation
   - suspected product bugs, harness bugs, model-quality issues, and observability
     gaps

9. Turn the harness into a rough-edge hunter.

   After every run, automatically propose follow-up work:

   - top three repeated or wasteful tool patterns
   - highest-risk approval or mutation sequence
   - largest context contributor and whether it was necessary
   - missing evidence that blocked confident triage
   - live-only failures that should become deterministic replays

The practical next implementation target is:

1. `scripts/generate-dogfood-vault.ts` for adversarial fixture creation.
2. `scripts/assert-dogfood-invariants.ts` for post-run invariant checks.
3. `scripts/report-dogfood-run.ts` for the run report.
4. One deterministic WDIO spec that combines generated vaults, scripted model
   replays, settings chaos, restart/reload checks, and invariant assertions.
5. One opt-in live spec that reuses the same report format so synthetic and live
   runs are comparable.

### Further Dogfood Stretch Ideas

After the first next-level harness is stable, push on workflows that look less
like a scripted demo and more like a naive user making the product work hard.

Use multiple vault personalities instead of only `~/MyTestVault` and the
generated dogfood vault:

- a tiny empty vault where every feature has to handle missing context
- a messy long-lived vault with old sessions, stale generated notes, broken
  links, forgotten memory, conflicting memory, and partial plugin state
- a non-code personal-knowledge vault to catch assumptions that every task is a
  DevOps repo inventory
- a deliberately hostile vault with secrets in ignored paths, huge notes,
  invalid YAML, duplicate names, Unicode paths, and misleading active notes

Force feature crossovers that users naturally create:

- change model/provider mid-session, send a prompt, then restore the original
  model and verify recovery
- attach files, active notes, folder listings, memory, and external roots in the
  same run, then check which context actually reached the model
- run `/plan`, `/endplan`, `/todo`, `/steer`, `/follow-up`, `/new`,
  `/sessions`, `/memory`, `/export`, `/undo`, `/diagnostics`, and `/config`
  around real tool calls instead of as isolated command smoke tests
- start long workflows that create notes, refine them, delete unused ones, check
  backlinks/local graph, export the transcript, reload the plugin, then continue
  from the intended active note

Attack the sad paths deliberately:

- unclear instructions that should trigger `ask_user`, followed by silence,
  late answers, irrelevant answers, denial answers, and stop/cancel
- approval modals closed, double-clicked, answered out of order, or left open
  while settings change
- denied first mutation in a multi-tool batch, verifying later mutations do not
  bypass approval
- invalid model id, missing API key, expired key, proxy failure, and restored
  settings recovery
- MCP enabled with no servers, disabled server tools, and a mock MCP server with
  slow, failing, and oversized tool results

Improve observability so failures are cheaper to mine:

- write a per-turn context ledger with active note, attached files, memory hits,
  external snippets, token estimate, and cache hit/miss evidence
- record approval lifecycle events separately from tool starts so modal-close,
  double-click, and settings-race behavior is obvious in traces
- cluster repeated tool calls by normalized operation and path, not just by raw
  JSON, to catch inefficient list/read/search loops
- emit run reports with "likely harness bug", "likely product bug",
  "model-quality issue", and "observability gap" classifications
- keep every live failure as a minimized deterministic replay before treating it
  as fixed

## Bug Capture Protocol

Create or update a local triage file during the session:

```text
DOGFOOD_BUGS.md
```

Use this template for each finding:

```markdown
## BUG-YYYYMMDD-NN: Short title

Severity: critical | high | medium | low
Status: new | reproed | fixed | needs-test | deferred
Area: approvals | external root | settings | sessions | rendering | model | docs | other

Environment:
- Vault:
- External root:
- Provider:
- Model:
- Plugin commit:
- Obsidian version:

Repro:
1. ...
2. ...
3. ...

Expected:

Actual:

Artifacts:
- Screenshot:
- Browser console:
- Session JSONL:
- Settings snapshot:

Notes:
- ...
```

Capture artifacts from these places when available:

```text
logs/e2e-artifacts/
<dogfood-vault>/.obsidian/plugins/agentic-chat/sessions/
<dogfood-vault>/.obsidian/plugins/agentic-chat/data.json
```

Before writing artifact contents into `DOGFOOD_BUGS.md`, redact:

- API keys and bearer tokens
- private URLs that should not leave the machine
- note contents unrelated to the bug
- large model outputs

Summaries are usually enough. Keep raw artifacts local unless the user asks to
package them.

## Fix Loop

For each bug:

1. Reproduce once with the live harness or manual dogfood.
2. Check session JSONL and browser console if the UI symptom is unclear.
3. Fix the smallest responsible code path.
4. Add a deterministic unit test or e2e test when the repro is stable.
5. Run focused verification.
6. Reinstall into the live vault.
7. Re-run the live scenario that exposed the bug.
8. Update `DOGFOOD_BUGS.md` with status and verification.

Common verification commands:

```bash
rtk npm run typecheck
rtk npm run lint
rtk npm test
rtk npm run test:e2e -- --spec test/e2e/specs/smoke.e2e.ts
```

Reinstall after fixes:

```bash
rtk npm run install:local -- "$TARGET_VAULT"
```

Use `dev:vault` if you want the built output to stream directly into the vault:

```bash
rtk npm run dev:vault -- "$TARGET_VAULT"
```

## Converting Findings Into Tests

Live dogfood findings should become deterministic coverage when possible:

- Pure logic bug: add or update a Vitest unit test.
- Approval behavior: prefer deterministic e2e with scripted model turns.
- UI layout/reload issue: add WDIO coverage if it can run without a live model.
- Provider-specific issue: keep a live opt-in spec and skip unless env vars are
  present.
- Model behavior or prompt-quality issue: record as dogfood guidance unless it
  exposes a deterministic product bug.

Do not turn a flaky live-model path into mandatory CI.

## Session End Checklist

At the end of a dogfood run:

```bash
rtk git status --short
```

Then report:

- bugs found
- fixes made
- tests run
- files intentionally changed
- uncommitted unrelated worktree changes that were left alone
- whether the patched plugin was installed into `TARGET_VAULT`

Remove temporary secrets only if the user asks. Leave live key files alone by
default because they may be reused in the next session.

## Suggested Kickoff Prompt

Use this when starting a new Codex session:

```text
Use docs/development/live-dogfood.md. Run the productized deterministic dogfood
target with npm run test:e2e:dogfood. Then, if live model dogfood is explicitly
requested and the AGENTIC_CHAT_LIVE_* environment is configured, run the opt-in
live dogfood sweep against the named vault/workspace, log findings in
DOGFOOD_BUGS.md, fix high-signal bugs as you find them, and rerun the relevant
deterministic dogfood coverage after each fix.
```
