# UI v2: design system

The rules the chat view is built on: tokens, the status vocabulary, and one
section per component. Change the code and this page together.

- **Mock:** [UI v2 mock](https://tardigrde.github.io/obsidian-agentic-chat/design/ui-v2-mock.html)
  on the docs site (source: `docs/public/design/ui-v2-mock.html`). One
  self-contained HTML file with three frames (sidebar with an approval, sidebar
  with a finished turn, phone) in light, dark, or auto.
- **Screenshots:** [light](https://tardigrde.github.io/obsidian-agentic-chat/design/ui-v2-mock-light.png),
  [dark](https://tardigrde.github.io/obsidian-agentic-chat/design/ui-v2-mock-dark.png).
- **Code:** `styles.css` (tokens at the top), `src/ui/chat-layout.ts`,
  `src/ui/tab-strip.ts`, `src/ui/activity-line.ts`, `src/ui/approval-card.ts`.

## Principles

1. **The conversation comes first.** The transcript gets the space. Controls
   stay quiet until they are needed.
2. **One turn, one unit.** A turn is the user message, one activity line, the
   answer, then sources and actions.
3. **Only what needs you gets loud.** Colour and borders are for the two
   moments that need a human: an approval and an error.
4. **One status vocabulary.** Five states with one meaning each, used by the
   tabs, the activity line, step rows, subagents, and the status line.
5. **Theme-native.** Every colour comes from Obsidian theme variables through
   the `--ac-*` token layer. Community themes, light, and dark work without
   per-theme CSS.
6. **Touch is not a fallback.** Every interaction has a touch path, every
   target is at least 44 px on a phone, and nothing depends on hover.

## Tokens

All raw colours, pixel sizes, and Obsidian variables live in one `--ac-*` block
at the top of `styles.css`. It is set on `body` (modals and settings live
outside the view) and again on `.agentic-chat-view`, so the view resolves the
theme variables of its own leaf. Every other rule uses only tokens.
`npm run check:css-tokens` (part of `verify -- check`) enforces it with an empty
allowlist; media query preludes may use `px`.

| Group | Tokens | Notes |
|---|---|---|
| Spacing | `--ac-space-0` 2, `-1` 4, `-1h` 6, `-2` 8, `-2h` 10, `-3` 12, `-3h` 14, `-4` 16, `-6` 24 px | A 4 px grid with half steps for dense rows |
| Lines | `--ac-line` 1, `--ac-line-strong` 2, `--ac-line-accent` 3 px | Borders and outlines |
| Radius | `--ac-radius-xs` 4, `-s` 6, `-m` 10, `-l` 16 px, `-pill` | |
| Type | `--ac-font-ui`, `-small`, `-tiny`, `-body` (the reading size), `-title`, weights | `--ac-font-body` is at least 16 px on touch |
| Surfaces | `--ac-surface`, `--ac-surface-raised`, `--ac-surface-sunken`, `--ac-border`, `--ac-hover` | Raised and sunken are text-colour tints, so they show on the sidebar and the main area alike |
| Text | `--ac-text`, `-muted`, `-faint`, `-on-accent`, `--ac-accent`, `--ac-link` | |
| Status | `--ac-status-running`, `-needs-you`, `-error`, `-done`, `-unread` | The only five state colours |
| Tints | `--ac-tint-error`, `-needs-you`, `-done`, `-add`, `-remove`, `-running` | `color-mix()` of a status into the surface |
| Sizes | `--ac-hit` 28 px (44 px on touch), `--ac-send` 32 px (40 px), `--ac-dot`, icons | |
| Motion | `--ac-motion` 160 ms ease-out | No animation with reduced motion |
| Phone inset | `--ac-safe-bottom` | Obsidian's `--view-bottom-spacing` in the main area of a phone, so the floating navbar never covers the composer |

## Status vocabulary

| State | Colour | Icon | Where it shows |
|---|---|---|---|
| `running` | accent | ring spinner, a pulsing dot on a tab | activity line, step row, tab dot, status line |
| `needs-you` | orange | hand | approval card, activity line, tab dot, overflow button |
| `error` | red | alert circle | step row, `· N failed`, tab dot |
| `done` | green | check circle | step row, activity line (finished) |
| `unread` | accent | solid dot | a background tab that finished while you were away |

A tab dot and the overflow button show the **most urgent** state among their
tabs: `needs-you` beats `error`, which beats `running`, which beats `unread`.
With `prefers-reduced-motion`, spinners and pulses are static.

## Layout

```
┌───────────────────────────────────────────┐
│ [1] [Plan•] [3•]  +2▾            ＋  ⟲     │  header: tabs · tab menu · new tab · history
├───────────────────────────────────────────┤
│                      ┌──────────────────┐ │
│                      │ user message     │ │  soft bubble, right
│                      └──────────────────┘ │
│ ✓ Read 4 notes, edited 1 · 12s ›          │  activity line (collapsed)
│ Assistant answer as plain prose …         │  no bubble
│ (▢ Note A) (▢ Note B)                     │  sources
│ ⧉ ↻  6s · 4.1k tokens · $0.004            │  actions + meta (hover; always on touch)
├───────────────────────────────────────────┤
│ ◌ Waiting for your approval               │  status line (only with news)
│ ╭───────────────────────────────────────╮ │
│ │ (▢ Active note ×)                     │ │  chips
│ │ Ask about your vault…                 │ │  textarea (1-8 lines)
│ │ ⌀ model · effort     ◔ 38%  ⛉Safe  ●  │ │  toolbar · send/stop
│ ╰───────────────────────────────────────╯ │
└───────────────────────────────────────────┘
```

## Components

### Header and tabs

- The header row holds the tabs, the tab menu button, **New tab** (`+`), and
  **History**. Up to 5 tabs (`MAX_TABS`); each tab owns an `AgentService`. `+`
  is disabled at the cap.
- **Label.** A tab shows its 1-based number, or its **tab label** once the user
  names it (ellipsised at 140 px). The tab label is not the session name: the
  session keeps its auto name (the first words of the first prompt) or a name
  set in history. The label is a `tab_label` entry in the session JSONL, so it
  survives a reload, a reopen from history, and a transcript rewrite. The
  tooltip is `Tab 2 · <session name>`.
- **Rename.** Double-click (desktop), long-press 500 ms (touch), or "Rename
  current tab" in the tab menu. Enter or blur saves, Esc cancels, an empty name
  brings the number back. Labels are trimmed and capped at 32 characters.
- **Overflow.** Tabs that do not fit the measured width go into the menu; the
  active tab always stays visible. The button reads `+N ▾` with the most urgent
  dot of the hidden tabs, or `⋯` when nothing is hidden. The menu lists the
  hidden tabs, then Rename current tab, Open from history…, Close current tab.
- **Close.** An × on hover or focus on desktop. On touch, close is only in the
  menu, so a stray tap does not close a tab.
- **Keyboard and a11y.** `role="tablist"` with roving tabindex; Left, Right,
  Home, and End move and activate. The status is in the tab's `aria-label`
  (`Tab 2, Project plan, needs approval`).

### Activity line

One line per turn, above the answer, shared by every assistant message of the
turn:

```
[status icon] <summary> [· N failed] <elapsed> ›
```

- **Summary.** Verbs in the order they first happen, counts merged per verb:
  `Searched vault, read 4 notes, edited 1` (`src/ui/activity-summary.ts`). MCP
  tools read `used <server> ×N`, subagents `ran N subagents`. Failed steps are
  left out of the verbs and counted as `· N failed`.
- **Running:** a spinner and the current action (`Reading Meetings/…`), or
  `Thinking…` before any step.
- **Needs you:** the orange hand, `· needs you`, and the line opens; the
  approval card renders right below it.
- **Finished:** a green check. A turn that ended in an error shows the red
  icon, and the inline error block (with Retry) follows the answer. A turn with
  no tool call and no reasoning hides the line.
- **Body:** reasoning first (`Thought for 3s: …`, folded to three lines, click
  to show all), then one compact row per tool call: status icon, short verb,
  argument (a clickable vault path when there is one), and time. A row with
  details opens on click; failed rows open by themselves. Subagent rows hold
  the subagent tree with a Stop per running child, and open while it runs.
- Collapsed by default for finished and replayed turns. The open state is per
  turn and not saved.

### Inline approval card

- Renders in the transcript of the tab that asked, below the turn's activity
  line, with the orange border and tint: a title, a one-line description, the
  preview (diff via `compactDiffLines`, capped at 400 lines, expandable), and
  **Allow**, **Always allow &lt;tool&gt;**, **Deny**. `create_skill` has no
  Always.
- **Keyboard.** The card takes focus unless the composer has text. Enter
  allows. Esc starts the two-step deny (a reason field and "Confirm deny");
  Enter in the reason confirms, Esc there goes back.
- **Background tabs.** The tab gets the orange dot and "needs approval" in its
  `aria-label`, and a notice fires. The card waits in that tab and shows when
  the user switches there. Nothing switches tabs on its own.
- **Stop, abort, or closing the tab** settles the card as stopped with
  `STOPPED_APPROVAL_REASON`.
- **Resolved:** the card collapses to one muted line (`Allowed once`,
  `Allowed: always for write`, `Denied`, `Stopped`) and stays as a record until
  the transcript re-renders.

### Messages

- **User:** right-aligned soft bubble (`--ac-surface-raised`), radius
  `l l s l`, at most 85 % wide. Click a sent message to edit and resend.
- **Assistant:** no container, full width, reading-size type, Obsidian's
  markdown rendering.
- **Sources:** outline pills under the turn's answer, for the files its tools
  read (failed reads excluded), capped at 8 with `+N`.
- **Actions and meta:** copy and retry, then the per-answer meta
  `6s · 4.1k tokens · $0.004` (time only when measured live). Shown on hover or
  focus on desktop, always on touch. There is no global usage line.
- **Info and slash output** (`/help`, `/status` …) is a quiet raised card.
- **Errors** use the red tint and the alert icon.

### Composer

- One rounded card with a soft shadow and an accent focus ring: chips (the
  active note has a dashed outline: attached automatically, removable), an
  auto-growing textarea (1 to 8 lines), and the toolbar.
- **Toolbar, left to right:** attach (opens the `@` note picker), **model ·
  effort** as one pill (the name opens the model picker; the muted effort value
  cycles the level, as does Alt+click on the pill), a spacer, the **context
  ring** with its %, **Safe / YOLO** (a shield, orange while YOLO, icon only on
  touch), and the round **send / stop**. While a turn runs, Stop shows and send
  queues (`data-ac-state` `send`, `queue`, `update`).
- **Context ring:** % only, no click action. On desktop the tooltip shows the
  estimated breakdown, and the provider's count for the last reply when it
  reported one. Known limit: the tooltip is hover-only, so a phone shows the %
  only. Sample (real output):

  ```
  38% · 48.6k / 128k tokens (estimated)
  System prompt       4.1k  3%
    Instructions      1.2k
    Skills loaded     0.8k
  Tools               6.3k  5%
    Built-in          4.0k
    MCP               2.3k  (2 servers)
    MCP deferred     14 tools, not loaded
  Conversation       35.2k  28%
    Tool results     21.0k
  Kept for answer     3k
  Last reply: 46.9k tokens sent (provider count)
  ```

  Deferred MCP tools are not sent, so they show as a count, not tokens.
- **Status line** above the card, only while it has news (`Working…`,
  `Waiting for your approval`, `Restored your draft`).
- **Queued follow-up:** the dashed chip in the chips row, same behaviour.

### Empty state

A sparkle icon, "What should we work on?", and one line on what the agent can
do and how `/` and `@` work. No suggestion buttons.

### Modals that stay

History, model picker, install plugin, new skill, quick ask, and the confirm
modal for destructive bulk actions stay modals and use the same tokens.

## Mobile

- Same layout and components. `--ac-hit` 44 px, body text at least 16 px (iOS
  does not zoom on focus), send 40 px.
- Long-press renames a tab; close is in the tab menu. Turn actions are always
  visible.
- The composer keeps `--ac-safe-bottom` free: the safe area, and in the main
  area also Obsidian's floating navbar.
- Covered by `test/e2e/specs/mobile-viewport.e2e.ts` (`npm run verify -- app --mobile`).

## Test hooks

Drivers select by `data-ac="<hook>"` (`src/ui/test-hooks.ts`), never by class:
`view`, `header`, `tab`, `tab-label`, `tab-input`, `tab-overflow`, `tab-menu`,
`activity`, `activity-head`, `step`, `approval`, `approval-allow`,
`approval-always`, `approval-deny`, `composer-input`, `send`, `stop`,
`context`, `turn-meta`, and more. State lives in `data-ac-state`.

## Motion

- 160 ms ease-out for hover, expand, and focus. No layout-shifting animation
  while streaming.
- New content pins to the bottom only when the view is already at the bottom
  (`scroll-pinning.ts`).
