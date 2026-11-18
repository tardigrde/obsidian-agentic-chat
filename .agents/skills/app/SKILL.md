---
name: App
description: Use for any run in the real Obsidian app - a committed e2e spec, a recorded run with video, the generated-vault dogfood, or a chaos explore. Drives the plugin in a throwaway vault, captures evidence, and keeps the feature map honest. Replaces verify-obsidian-chat, probe-feature, and chaos-monkey.
---

# App

The unit layer fakes Obsidian; this skill drives the real app. What to run for
which change: [testing.md](../../../docs/development/testing.md).

## Commands

```bash
npm run verify -- app [spec...] [--mobile] [--dogfood]   # assertions: the verdict
npm run verify -- app --record <scenario> [--live]       # video + keyframes + metrics
npm run verify -- explore [--mode explore --live] [--charter c]   # leads, not proof
```

On a desktop, wrap headed runs: `npm run nested -- <command>` (a nested Xephyr,
so Obsidian windows do not steal the cursor). `--record` and `explore` own their
display already.

| Need | Mode |
|---|---|
| The correct result is known (bug, refactor, UI wiring) | `app <spec>`: a committed spec in `test/e2e/specs/` |
| A multi-tool agent flow over a hostile vault, no model | `app --dogfood` (generated vault, invariant oracle; CI runs it) |
| A clip or metrics for a human (layout, a live turn) | `app --record layout-smoke` or `--record live-chat --live` |
| The correct behavior is unknown | one recorded run with one falsifier, max 3 runs, then promote it to a spec or delete it |
| Several PRs shipped, or breadth before a release | **propose** one `explore --mode explore --live` run to the owner; it runs on request only |

Every run writes `logs/verify/<ts>/run-result.json`: verdict, mode (`scripted`,
`live`), command, counts, cost, and artifact folders. A recorded run that
executes no test, or skips one, fails. `--live` works only for a scenario that
drives a real model (`live-chat`); its cost is not measured (the report says 0).
A used `--out` is refused.

## Doctor

Before you trust a run:

- The bundle is the one you just built: every mode rebuilds first.
- The vault is a throwaway sandbox, never `~/MyTestVault`. Explore refuses any
  path outside its temp root.
- The reporter header shows a `Session ID` and the Obsidian version.
- A live run needs `AGENTIC_CHAT_API_KEY`; without it the live spec skips. Read
  the counts.

## Drive

| surface | handle |
|---|---|
| open chat | `browser.executeObsidianCommand("agentic-chat:open-chat")` |
| composer | `.agentic-chat-input`, `.agentic-chat-send` |
| transcript | `.agentic-chat-messages`, `.agentic-chat-assistant .agentic-chat-text` |
| tool card | `.agentic-chat-tool`, `.agentic-chat-step-diff-line.is-add` |
| approval | `.agentic-chat-approval`, `button=Allow`, `button=Deny` |
| settings | `test/e2e/support/settings-ui.ts` (settings open in a popout window) |
| vault state | `browser.executeObsidian(...)` |

Use stable handles, not coordinates. Drive the user path, not an internal
setter. Check side effects (note exists, content changed, JSONL written) next to
what is visible. Wait on a state, never on a fixed sleep.

## Evidence

- **UI change:** a committed e2e assertion that fails without the change, plus
  one screenshot attached to the PR. No video is required.
- **Removal:** a `kind: removal` witness, plus the command gone from `/help` and
  the registry, and the feature map row gone or marked removed.
- **Mode:** `scripted` uses the `__AGENTIC_CHAT_E2E_TURNS__` hook; `live` means a
  real model answered. Never present scripted as live.
- A recording is evidence for a human. Do not turn it into a pixel comparison.

## Explore

Explore is a live exploratory run, not a gate. An explorer model reads every
Obsidian window, acts (click, type, command, prompt, resize, reload), and a miner
writes `findings.md` and issue drafts under `logs/chaos/<run>/`. Nothing is
filed: a human reads the drafts.

- Charters: `charters/` next to this file (`broad`, `settings`, `composer`,
  `notes-approvals`, `sessions`, `layout`), a path, or plain text.
- Model lock: the plugin, explorer, and miner use `deepseek/deepseek-v4.1-flash`.
  `--llm opencode` runs the explorer and miner on the flat-rate subscription.
- Caps: steps, seconds, calls, tokens. Stop a run with
  `touch logs/chaos/<run>/CANCEL`.
- `--replay <run>` repeats recorded decisions without explorer calls.
- Check every finding in code or by replay before it becomes work. A real
  finding gets a deterministic test first (unit, replay, or e2e) that fails today.

## Feature map

`features/` maps every user entry point to its code and its proof
([index and proof rules](./features/README.md)). When a change adds, removes, or
changes an entry point, update its row: entry points, proof, status. `check`
runs `scripts/check-feature-map.mjs`, which fails on a missing file or test.

## Gotchas

- **Popout settings.** Capture the display, not a window.
- **Headless lies.** `--ozone-platform=headless` has no accessibility tree; use
  DOM text or `executeObsidian`.
- **Proxy.** Chromedriver stays off the proxy; `wdio.conf.mts` strips it.
- **Async saves.** After a settings change, poll the stored value.
- **Scripted turn order.** One tool call uses one turn; a denied call still
  needs its follow-up text turn.
- **Cleanup.** Stop only the instance you started; never kill by process name.
