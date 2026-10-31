---
name: Verify Obsidian Chat
description: Use when you need to prove behavior in the real Obsidian app for this plugin: launch a throwaway vault, drive a user journey, capture evidence, and check every entry point in the feature map.
---

# Verify Obsidian Chat

The unit layer fakes Obsidian. This skill drives the real app. It is adapted from
pstack's `create-verification-skill` by Lauren Tan (MIT), narrowed to this repo.

## Launch

Two ways in:

```bash
npm run probe -- --scenario settings-gate     # recorded exploratory run
npm run verify -- e2e test/e2e/specs/smoke.e2e.ts
```

`probe` starts an isolated Xvfb display and records the whole display with ffmpeg,
so Obsidian settings popouts are in frame. `verify -- e2e` runs a committed spec
without recording.

Both build first. Scripted probes use the E2E stream bundle; live probes use the
production bundle. `wdio.conf.mts` loads `test/e2e/probe/**` only when
`AGENTIC_CHAT_PROBE=1`.

## Doctor

Before trusting a run, check:

- The plugin under test is the one you just built. `probe` rebuilds by default;
  `verify -- e2e` runs `scripts/build-e2e.mjs` first.
- The vault is the throwaway sandbox, not `~/MyTestVault`.
- `Session ID` and Obsidian version appear in the reporter header.
- For live runs, `AGENTIC_CHAT_API_KEY` is present. A missing key skips tests and
  still exits 0; read the counts.
- `DISPLAY` points at Xvfb for probes. Never record the host desktop by accident.

## Drive

Verified selectors and helpers:

| surface | handle |
|---|---|
| open chat | `browser.executeObsidianCommand("agentic-chat:open-chat")` |
| composer | `.agentic-chat-input`, `.agentic-chat-send` |
| transcript | `.agentic-chat-messages`, `.agentic-chat-assistant .agentic-chat-text` |
| tool card | `.agentic-chat-tool`, `.agentic-chat-diff-line.is-add` |
| approval | `.agentic-chat-approval`, `button=Allow`, `button=Deny` |
| info block | `.agentic-chat-info` |
| settings | `test/e2e/support/settings-ui.ts` |
| vault state | `browser.executeObsidian(...)` |

Settings on Obsidian 1.13+ open in a **popout window**. `settings-ui.ts` switches
handles for you. Do not assume the settings DOM is in the main window, and do not
assume a single window when recording.

Use stable handles, not coordinates. Drive the user path, not an internal setter.
Verify side effects (note exists, content changed, JSONL written) alongside what
is visible.

## Evidence

For a UI claim, produce:

- `session.mp4` (default; GIF only when you pass `--gif`) or a committed e2e assertion
- keyframes at each mark (`shots/`)
- `metrics.json`: viewport, overflow, element rects, console errors
- `timeline.json`: one entry per `record.mark(label)`
- `report.md`: hypothesis, observed, decision, open questions

The video is evidence for a human. The assertion is the regression guard. Do not
promote a recording into CI as a pixel comparison; timing, model text, and cursor
position differ every run.

State the mode. `mode: live` means a real model answered. `mode: scripted` uses
the `__AGENTIC_CHAT_E2E_TURNS__` hook. Never present scripted as live.

## Cleanup

Delete or trash notes the run created. Stop the instance you started; never kill
by process name. Keep evidence after teardown. `probe` owns Xvfb and ffmpeg and
cleans both up.

## Gotchas

- **Popout settings.** Capture the display, not a window. Without a window manager
  the popout can be placed oddly; if it is off-screen, run `openbox` inside Xvfb.
- **Headless is not enough.** `--ozone-platform=headless` has no accessibility
  tree, so `getText()` lies. Use DOM text or `executeObsidian` when headless.
- **Proxy.** Chromedriver must stay off the proxy; `wdio.conf.mts` strips it.
- **Stale bundle.** `main.js` is gitignored. Rebuild before asserting.
- **Live skip.** An empty key makes the live spec skip, not fail.
- **Async saves.** After changing a setting, poll the plugin settings value; do not
  assume the save landed.
- **Scripted turn order.** One tool call consumes one turn, and a denied call still
  needs its follow-up text turn. Keep the queue aligned.

## Feature map

Start here, then update it when entry points change:

- [Chat turn](./features/chat-turn.md)
- [Slash commands](./features/slash-commands.md)
- [Settings](./features/settings.md)

Each entry names every way a user reaches the feature and how to prove it. A proof
that drives one convenient entry point is incomplete when the map lists others.
