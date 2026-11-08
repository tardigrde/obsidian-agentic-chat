---
name: Chaos Monkey
description: Use after several PRs ship, or when you want exploratory live testing of the real chat plugin instead of another fixed e2e spec. Opens a seeded throwaway vault, drives the real Obsidian UI and real model calls, and writes a capped report under logs/chaos/.
metadata:
  opencode/autoinvoke: false
---

# Chaos monkey

A chaos monkey is a live exploratory run, not a gate. It opens a disposable
vault, drives the real Agentic Chat plugin through its UI, makes real model calls
when a key is present, and reports what broke with evidence.

Use it to replace the human step of "open Obsidian after a release and try
things". Use `@break-change` when you need to attack one change or prove a
removal. Use this when you want breadth after several changes.

## When to run it

| situation | mode |
|---|---|
| A named surface changed and you want live breadth: settings, composer, notes, MCP | `focused --target <surface>` |
| Several PRs shipped and no single change is the target | `generic` |
| You need a quick no-key sanity pass over the driver and safety guards | dry run (default) |
| You suspect a provider, tool, or settings interaction that a fixed spec misses | `focused` or `generic` with `--live` |

Do **not** use it as a merge gate. A green chaos run does not replace the
witness, `npm run verify -- fast`, or a committed e2e assertion.

## Safety rules

1. **Throwaway vault only.** The runner creates a new
   `<temp>/chaos-monkey-*` directory, writes a seed marker, and refuses any path
   outside the temp root. You cannot point it at `~/MyTestVault`. There is no
   vault flag.
2. **No secrets.** The key is read from the environment, never written to
   `plan.json`. The report and action log redact it.
3. **Dry run by default.** Without `--live`, the driver uses scripted turns. A
   dry run cannot spend tokens and is labelled `live: false` everywhere.
4. **Hard caps.** Steps, wall time, model calls, and an estimated token budget
   stop the run. The defaults are small. Do not raise them without a reason.
5. **Kill switch.** Run
   `touch logs/chaos/<timestamp>/CANCEL` to stop at the next step.
   `Ctrl-C` writes the same file and terminates the Obsidian run.
6. **Cleanup.** The seed root is removed on success, failure, and interruption
   unless `--keep` is passed. `--keep` is for debugging only.

## Run it

```bash
# Dry run (no key needed): proves the driver, the vault guard, and the caps
npm run chaos -- --mode focused --target settings

# Focused dry run against notes, with tighter caps
npm run chaos -- --mode focused --target notes --max-steps 2 --max-seconds 90

# Generic dry exploration
npm run chaos -- --mode generic --max-steps 6 --max-seconds 120

# Tiny live run (requires the key in the environment, usually .env)
AGENTIC_CHAT_API_KEY=... npm run chaos -- \
  --mode focused --target composer --live \
  --max-steps 2 --max-seconds 180 --max-calls 2 --max-tokens 4000
```

Focused targets:

| target | what the driver does |
|---|---|
| `composer` | one real prompt, `/help`, `/dirs` |
| `settings` | opens Agentic Chat settings, switches every tab, toggles MCP on and off, closes |
| `notes` | asks for a note, approves the write when asked, reads the note back |
| `mcp` | opens Advanced, enables MCP, adds a server, reads the server row |
| `retired-commands` | sends `/steer`, `/follow-up`, `/redirect`, `/todo`, `/todos`, `/plan`, `/mode`, `/config`, `/project` and checks a clean response and valid session JSONL |
| `steer` | starts a tool turn, steers it with a second text, checks the steer lands before the answer |
| `queue` | queues a draft, edits it while the turn runs, checks it flushes at turn end |
| `stop-send` | stops a running turn, sends the held replacement, checks the old turn is abandoned |
| `max-turns` | forces more tool iterations than the assistant-turn cap and checks the visible stop message |
| `settings-persistence` | changes one value per tab, reloads Obsidian and the plugin, checks the values |
| `approval-paths` | denies one write and allows the next, then checks both notes |
| `session-reload` | switches sessions, reloads the plugin mid-conversation, checks the transcript and JSONL |
| `large-input` | sends a very large prompt and checks overflow and composer responsiveness |
| `mcp-lifecycle` | adds, tests, and removes an MCP server, then checks saved settings |

Generic mode chooses from the same actions with a seeded random stream. Every
action is one slot in the pool, so note writes no longer dominate a generic run.

`max-turns` reserves the full assistant-turn budget (25 model calls). A focused
dry run needs `--max-calls 25` or higher. With a smaller cap the action is
recorded as skipped, like any other action that does not fit.

## Read the result

```text
logs/chaos/<timestamp>/
  report.md          verdict, caps, steps, findings, safety, artifacts
  session.mp4        whole-display recording (settings popouts in frame)
  shots/             screenshots and keyframes
  action-log.jsonl   one line per driver action
  driver-result.json machine-readable steps, findings, notes, counters
  metrics.json       counts used by the report
  plan.json          mode, target, caps, model, no secrets
  vault-info.json    temp vault path, seeded notes, guard description
  sessions/          copied session JSONL, when the plugin wrote it
```

Verdicts:

| verdict | meaning |
|---|---|
| `PASS` | Every planned step passed. This is breadth evidence, not a gate. |
| `FINDINGS` | At least one step failed or the driver raised a finding. Read the repro and evidence. |
| `INCONCLUSIVE` | The driver did not run, or ran zero steps. Fix the harness before judging the product. |

A finding is a lead. Promote it: write a failing deterministic unit, replay, or
e2e test, then fix the product. Never leave the only proof in a chaos report.

## Caps and cost

- `--max-steps` counts user-visible actions, not tool calls. A skipped action
  does not spend a step.
- `--max-seconds` caps driver wall time. The runner adds a fixed boot allowance
  before it kills the child.
- `--max-calls` caps model calls. Slash-command steps do not count. An action
  reserves its full estimate before it runs; when the estimate does not fit, the
  step is skipped with the needed and remaining calls and the run continues. It
  stops with `max-calls` only when nothing left fits or the cap is reached.
- `--max-tokens` is an estimate: prompt and answer characters / 4 plus a small
  time term. It is a safety brake, not billing telemetry.

For a live run, start with `--max-steps 1 --max-calls 1 --max-tokens 2000`.
Raise the caps only after the first run is clean.

## What the driver does not do

- It does not run OAuth or a live MCP tool call. Use
  `test/e2e/specs/mcp-live.e2e.ts` for that. The MCP step proves the settings
  surface and records the limitation in the report.
- It cannot force a live model to keep looping. A live `max-turns` run depends
  on the model choosing to make more than the assistant-turn limit; a model that
  refuses is a limitation, not proof the cap is broken. The dry run proves the
  cap deterministically.
- A full Obsidian renderer reload drops the WDIO Obsidian bridge, so
  `settings-persistence` proves the values through `data.json` (the restart
  source) and a plugin reload, and records that limitation.
- It does not prove mobile layout. It records a desktop display at the requested
  size.
- It does not replace a witness, a deterministic lane, or an independent PR
  verdict.

## Related

- `@break-change` for a bounded adversarial gate on one change.
- `@probe-feature` for a recorded before/after when correct behavior is unknown.
- `@verify-obsidian-chat` for selectors and real Obsidian evidence rules.
- `docs/development/verification.md` for the lane reference.
