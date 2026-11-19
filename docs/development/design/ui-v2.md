# UI v2: design spec

Status: **proposal, waiting for owner review.** Nothing in `src/` changes until
this is approved. The plan at the end turns it into PRs.

- **Mock:** [`docs/public/design/ui-v2-mock.html`](https://github.com/tardigrde/obsidian-agentic-chat/blob/claude/great-rubin-r97pij/docs/public/design/ui-v2-mock.html).
  It's one self-contained HTML file. Open it in any browser; once merged it's also on
  the docs site at `/obsidian-agentic-chat/design/ui-v2-mock.html`. It shows three
  frames (sidebar with an approval pending, sidebar with a finished turn, phone) in
  light, dark or auto. Tab rename, `/rename`, the overflow menu, activity
  expand/collapse and the approval buttons all work.
- **Screenshots** (readable on a phone, straight from GitHub):
  [light](https://github.com/tardigrde/obsidian-agentic-chat/blob/claude/great-rubin-r97pij/docs/public/design/ui-v2-mock-light.png),
  [dark](https://github.com/tardigrde/obsidian-agentic-chat/blob/claude/great-rubin-r97pij/docs/public/design/ui-v2-mock-dark.png).

## The brief (from the owner interview, 2026-11-19)

| Topic | Decision |
|---|---|
| What "10x" means | A polished, calm look; agent work that's easy to read; managing several chats |
| Main surface | Right sidebar (narrow). **Mobile is equally important.** |
| Reference look | Claude.ai / ChatGPT: the conversation comes first, quiet containers |
| Tab names | **Numbered by default**, renamed by the user |
| Rename | Double-click (desktop), **long-press** (touch), `/rename <name>` |
| Tab limit | Raise it; tabs that don't fit go into an overflow menu |
| Tool calls | **One collapsed summary line per turn**, expanded on demand |
| Scope | Visuals, layout **and flows** (modals may become inline UI) |
| Off-limits | Nothing |

## Principles

1. **The conversation comes first.** The transcript gets the space. Controls
   recede until they're needed, then appear where your eyes already are.
2. **One turn, one unit.** A turn is the user message, one activity line, the
   answer, then sources and actions. Nothing else gets a card unless it needs
   you.
3. **Only what needs you gets loud.** Colour and borders are kept for the two
   moments that need a human: an approval and an error. Everything else uses
   muted text.
4. **One status vocabulary.** Five states with one meaning each. The tab strip,
   activity line, step rows, subagents and the status line all use them.
5. **Theme-native.** Every colour comes from Obsidian theme variables through a
   small `--ac-*` token layer. Community themes, light and dark all work without
   per-theme CSS.
6. **Touch is not a fallback.** Every interaction has a touch path, every target
   is at least 44px on mobile, and nothing depends on hover.

## References and what we take from each

| Source | We take | We leave |
|---|---|---|
| Claude.ai | No bubble on assistant replies, a soft user bubble, one collapsible "thinking / tool use" line per turn, quiet hover actions, an empty state with suggestions | Artifacts side panel (we have notes) |
| ChatGPT | Rounded composer card with tools inside it, a circular send/stop button, a model picker in the composer | The sidebar-first history (our history is a modal plus tabs) |
| Cursor / Zed agent panels | Compact step rows with status icon, name, argument and time; inline diffs for approval; a queued follow-up | Density as the default (we collapse instead) |
| VS Code Copilot Chat | Approvals inside the transcript ("Continue / Cancel" cards) with keyboard shortcuts | The separate "Working set" pane |
| Vercel AI Elements / assistant-ui | Part names: Message, Reasoning, Tool, Sources, Actions, PromptInput. Each part owns its states | React/Tailwind (we stay on Obsidian DOM helpers) |
| Shape of AI (pattern catalogue) | "Stream of thought" and "Action plan" patterns, the named states (in progress, needs input, failed) | — |
| Browser tabs | Double-click to rename, an overflow chevron, an activity dot on background tabs | — |

## Tokens

The plugin defines a single `--ac-*` layer on `.agentic-chat-view`. Component
CSS uses only `--ac-*` tokens, never raw colours or ad-hoc pixel values (PR 1
adds a lint for this).

```css
.agentic-chat-view {
  /* spacing: 4px grid */
  --ac-space-1: 4px;  --ac-space-2: 8px;  --ac-space-3: 12px;
  --ac-space-4: 16px; --ac-space-6: 24px;
  /* radius */
  --ac-radius-s: 6px; --ac-radius-m: 10px; --ac-radius-l: 16px; --ac-radius-pill: 999px;
  /* type */
  --ac-font-ui: var(--font-ui-small);       /* chrome, steps, toolbar */
  --ac-font-small: var(--font-ui-smaller);  /* meta, chips, timestamps */
  --ac-font-body: var(--font-text-size);    /* messages follow the user's reading size */
  --ac-line-body: var(--line-height-normal);
  /* surfaces + text */
  --ac-surface: var(--background-primary);
  --ac-surface-raised: var(--background-secondary);
  --ac-border: var(--background-modifier-border);
  --ac-hover: var(--background-modifier-hover);
  --ac-text: var(--text-normal);
  --ac-text-muted: var(--text-muted);
  --ac-text-faint: var(--text-faint);
  --ac-accent: var(--interactive-accent);
  /* status: the only five state colours */
  --ac-status-running: var(--interactive-accent);
  --ac-status-needs-you: var(--color-orange);
  --ac-status-error: var(--color-red);
  --ac-status-done: var(--color-green);
  --ac-status-unread: var(--interactive-accent);
  /* interaction */
  --ac-hit: 28px;
  --ac-motion: 160ms cubic-bezier(.2, .7, .2, 1);
}
.is-mobile .agentic-chat-view { --ac-hit: 44px; }
```

Tints such as the approval background or a diff line are
`color-mix(in srgb, <status> N%, var(--ac-surface))`. Obsidian's minimum
Electron and mobile WebViews support `color-mix`, and PR 1 checks this in
`verify:mobile`.

## Status vocabulary

| State | Colour | Icon | Where it shows |
|---|---|---|---|
| `running` | accent | ring spinner, or a pulsing dot on a tab | activity line, step row, tab dot, status line |
| `needs-you` | orange | hand / pencil | approval card, activity line, tab dot, overflow item |
| `error` | red | alert circle | step row, `· N failed` on the activity line, tab dot |
| `done` | green | check circle | step row, activity line (finished) |
| `unread` | accent | solid dot | background tab that finished while you were away |

A tab dot and the overflow button show the **most urgent** state among their
tabs: `needs-you` beats `error`, which beats `running`, which beats `unread`.
Users with reduced motion get no pulsing and no spinner animation (static ring).

## Layout

```
┌───────────────────────────────────────────┐
│ [1•] [Project plan•] [3•]  +3▾     ＋  ⟲  │  header: tabs · overflow · new · history
├───────────────────────────────────────────┤
│                      ┌──────────────────┐ │
│                      │ user message     │ │  soft bubble, right
│                      └──────────────────┘ │
│ ✓ Read 4 notes, edited 1 · 12s ›          │  activity line (collapsed)
│ Assistant answer as plain prose, full     │  no bubble
│ width, reading-size type…                 │
│ (▢ Note A) (▢ Note B)                     │  sources
│ ⧉ ↻ ✎  6s · 4.1k tok · $0.004             │  actions on hover (always on touch)
│                                           │
├───────────────────────────────────────────┤
│ ◌ Waiting for your approval               │  status line (only while it has news)
│ ╭───────────────────────────────────────╮ │
│ │ (▢ Active note ×)                     │ │  chips
│ │ Ask about your vault…                 │ │  textarea
│ │ ⌀ Sonnet 5.5 · high ▾     ◔ 38%  ⛉Safe ● │  toolbar · send/stop
│ ╰───────────────────────────────────────╯ │
└───────────────────────────────────────────┘
```

The tab strip moves **from the composer row to a header row**. Tabs are
navigation and the composer is for input, so mixing them crowded the narrow
pane and pushed the composer's top edge around whenever tabs changed.

## Components

### Tabs (header)

- **Label.** The tab number (1-based position) unless the user has named the
  tab; then the name, ellipsised at 140px.
- **Names have a source.** Sessions are auto-named today from the first prompt
  (`session-event-recorder.ts#autoNameSession`), which feeds history. That stays.
  The session `name` entry gets `source: "auto" | "user"`, and **a tab shows
  only a `user` name**. The tooltip shows `Tab 2 · <auto name>` so the auto
  title is still there on hover. Older entries with no source count as `auto`.
  The history modal shows either kind.
- **Rename.**
  - Desktop: double-click or F2 on a focused tab turns the label into an inline
    input. Enter or blur saves, Esc cancels.
  - Touch: long-press (500 ms, cancelled by movement) opens the same inline
    input.
  - Composer: `/rename <name>` renames the active tab. `/rename` with no argument
    clears the name and brings the number back. It's in the slash autocomplete.
  - Overflow menu: "Rename current tab".
  - An empty or whitespace-only name clears it. Names are trimmed and capped at
    60 characters.
  - The name persists through `renameSession` with `source: "user"`. It shows up
    in history and in export titles, and it survives a reload.
- **Limit.** `MAX_TABS` goes from 3 to **8**. Each tab owns an `AgentService`,
  and 8 keeps memory bounded on mobile. The strip shows as many tabs as fit the
  measured width (a `ResizeObserver` on the header), always including the active
  one. The rest go into a **`+N ▾`** button whose dot is the most urgent state
  among the hidden tabs.
- **Overflow menu.** Hidden tabs (number, name or auto-name, status dot), then
  Rename current tab, Open from history…, and Close current tab.
- **Close.** An × appears on hover or focus on desktop. On touch, close lives in
  the overflow menu, so a stray tap doesn't close a tab.
- **Keyboard and a11y.** `role="tablist"` with roving tabindex. Left/Right move
  between tabs and Enter activates. Two new commands, "Next chat tab" and
  "Previous chat tab", with no default hotkeys. The status goes into the tab's
  `aria-label` ("Tab 2, Project plan, needs approval").

### Activity line (replaces the step-card timeline)

One line per assistant turn, placed above the answer text:

```
[status icon] <summary> [· N failed] <elapsed> ›
```

- **Summary grammar.** Verbs are grouped in the order they first happen:
  `Searched vault, read 4 notes, edited 1`. Each tool supplies a short verb and
  noun through `TOOL_LABELS`, and counts merge per verb. MCP tools read
  `Used <server> ×N`. Subagents read `Ran 2 subagents`.
- **While running:** a spinner, then the current action ("Reading Meetings/…")
  or "Thinking…" while only reasoning streams.
- **Needs you:** an orange icon and `· needs you`. The line **auto-expands**,
  and the approval card renders right below it.
- **Errors:** the line stays green if the turn finished. A red `· N failed`
  suffix marks failed steps, and they show expanded with their error text. A
  turn that ended in an error shows the red icon, and the existing inline error
  block (with retry) follows the line.
- **Expanded body:** reasoning first, as muted italic "Thought for 3s: …"
  (folded to 3 lines, click to show all). Then one compact row per tool call:
  status icon, verb, argument (a clickable vault path when there is one), and
  time. Clicking a row shows its arguments and result (the existing
  `formatCallBody` output). Edit rows show the compact diff.
- **Reasoning folds in.** The separate reasoning pill goes away; it becomes the
  first entry in the activity body.
- **Subagents** render as rows whose detail is the existing subagent tree, with
  the per-child stop button.
- **Persistence.** Collapsed by default for history replay and finished turns.
  The open or closed state is per turn and not saved.

### Inline approval card (replaces `ApprovalModal`)

- Renders in the transcript, inside the turn that asked, below the activity
  line. It has an orange border, the action title (`Edit Projects/Plan.md`), a
  one-line description (`+6 −1 · replaces "Next steps"`), the compact diff
  (`compactDiffLines`, capped at the current 400 lines and scrollable), and
  three actions: **Allow**, **Always for (this note / this tool)**, **Deny**.
- **Keyboard.** When the card appears it takes focus unless the composer has
  text. Enter allows and Esc denies (the two-step deny guard from the modal
  stays for destructive tools). The shortcut hint shows on the right.
- **Background tabs.** The tab gets the orange dot and its `aria-label` says
  "needs approval". The approval is waiting in that tab's transcript, which
  replaces the "click to review" modal hand-off.
- **Stop or abort.** The card resolves to "Stopped" with the same
  `STOPPED_APPROVAL_REASON`.
- **Resolved.** The card collapses to one muted line ("Allowed once" / "Denied")
  and stays in the transcript as a record.
- **Fallback.** Settings → Agent gets "Approval style: Inline (default) /
  Dialog" for one release, so a regression has an escape hatch. The modal stays
  until PR 8.

### Messages

- **User:** right-aligned, `--ac-surface-raised`, radius `l l s l`, max 85%
  width. Attached notes render as inline chips. Edit (pencil) appears on hover,
  as today.
- **Assistant:** no container, full width, reading-size type with Obsidian's
  markdown rendering. While streaming it shows a soft caret.
- **Sources:** the existing source chips, restyled as outline pills.
- **Actions:** copy, retry, save as note, plus a meta line `6s · 4.1k tokens ·
  $0.004`. The meta moves here from the global usage line. Shown on hover or
  focus on desktop, always on touch.
- **Info and slash output** (`/context`, `/help`…) renders as a quiet card in
  `--ac-surface-raised`, with no accent border.
- **Errors:** the inline error block keeps its behaviour, restyled to the red
  tint and the alert icon.

### Composer

- One card, radius `l`, with a soft shadow and an accent focus ring:
  - chips row (an active note shows a dashed outline: attached automatically,
    removable)
  - an auto-growing textarea (1 to 8 lines)
  - toolbar
- **Toolbar, left to right:**
  - attach (opens the @ menu)
  - **model · effort** as one pill, with effort muted. Click opens the model
    picker; the effort control is inside it, plus Alt+click to cycle.
  - spacer
  - **context ring + %**, shown once usage is known. Click runs `/context`.
  - **Safe / YOLO**: a shield icon with a label, orange when YOLO. On mobile it's
    the icon only.
  - **send / stop**: a circular button that swaps to stop while running.
- **Status line** above the card, only while it has news ("Waiting for your
  approval", "Compacting…", "Restored your draft").
- **Queued follow-up:** the dashed preview row above the card stays, with the
  same behaviour.
- **Placeholder** is shorter: `Ask about your vault…  / commands · @ notes`.

### Empty state

A sparkle icon, "What should we work on?", one line saying you approve every
change, and three suggestion buttons. The first uses the active note
("Summarize **Project plan**"); the others come from a fixed list. Clicking a
suggestion fills the composer and does not send.

### Modals that stay

History, model picker, install plugin, new skill and quick ask stay as modals.
They get the same tokens (radius, buttons, status icons) in PR 7. The confirm
modal for destructive bulk actions stays.

## Mobile

- Same layout and same components. `--ac-hit: 44px`, body text at least 16px
  (prevents iOS zoom on focus), send button 40px.
- Long-press renames a tab, and close is in the overflow menu.
- Turn actions are always visible, and nothing is hover-only.
- The composer card sticks to the bottom and respects the keyboard inset
  (`env(safe-area-inset-bottom)` plus Obsidian's mobile toolbar).
- Covered by the existing `mobile-viewport.e2e.ts` and `test:e2e:mobile`. Every
  UI PR adds a mobile assertion, not only a desktop one.

## Motion

- 160 ms ease-out for hover, expand and focus. No layout-shifting animation
  while streaming.
- Spinner and pulse only for `running`. With `prefers-reduced-motion`, all
  animation is off (the existing rule widens to cover the new parts).
- New content pins to the bottom only when you're already at the bottom (the
  existing `scroll-pinning.ts` behaviour stays).

## What goes away

| Today | v2 |
|---|---|
| Numbered tab pills in the composer row, max 3 | Named-or-numbered tabs in the header, max 8, overflow menu |
| One step card per tool call with a chevron outside the card and a timeline rail | One activity line per turn with compact rows inside |
| Reasoning pill as its own block | First entry of the activity body |
| `ApprovalModal` | Inline approval card (modal kept behind a setting for one release) |
| Global usage line | Per-turn meta in turn actions; context ring in the toolbar |
| Coloured accent borders on info blocks | Quiet raised card |

## Code map

| Area | Files today | Change |
|---|---|---|
| Tokens | `styles.css` (2,182 lines, 180 classes) | New `--ac-*` block at the top; components migrate PR by PR; dead rules deleted |
| Tabs | `ui/chat-tabs.ts`, `ui/chat-layout.ts`, `ui/chat-tab-state.ts` | Header row, labels, rename, overflow, `MAX_TABS = 8` |
| Name source | `session/session-manager.ts`, `session/jsonl.ts`, `agent/session-event-recorder.ts` | `source` on the name entry |
| `/rename` | `ui/slash/session.ts`, slash registry | New command |
| Activity line | `ui/assistant-bubble.ts`, `ui/step-card.ts`, `ui/subagent-tree.ts`, `ui/format.ts` | New `ui/activity-line.ts`; step-card becomes row rendering |
| Approval | `ui/approval-modal.ts`, `ui/chat-tabs.ts` (`pendingApprovalModal`) | New `ui/approval-card.ts`; shared preview builder stays in `agent/edit-preview.ts` |
| Messages and actions | `ui/transcript-view.ts`, `ui/chat-turn.ts`, `ui/assistant-markdown.ts` | Layout and actions restyle |
| Composer | `ui/chat-layout.ts`, `ui/composer-*.ts`, `ui/chat-chrome.ts` | Toolbar reorder, status line, placeholder |
| Empty state | `ui/chat-view.ts#renderEmptyState` | Suggestions |

## PR plan

Each PR is shipped with `@ship-change` under a `@factory` run. Each one
carries a witness (an e2e assertion that fails before the change), a desktop
and a mobile screenshot, a `verify -- check` summary, and an agent review.
Owner "merge" gates every one.

| # | PR | Witness |
|---|---|---|
| 1 | **Tokens + status vocabulary.** Add the `--ac-*` layer and migrate colours and spacing with no layout change. Add a lint (`scripts/check-css-tokens.mjs`) banning raw colours and px outside the token block, with an allowlist that shrinks every PR. | Lint fails on a raw hex in `styles.css`; e2e checks computed `--ac-status-*` resolve under light and dark |
| 2 | **Tabs v2.** Header row, numbered-or-user-named labels, `source` on session names, double-click / F2 / long-press rename, `/rename`, `MAX_TABS = 8`, overflow menu, status dots. | e2e: rename via double-click and via `/rename`, reload, label persists; 6 tabs in a 360px pane shows `+N` and the menu lists the rest; unit: auto names don't label tabs |
| 3 | **Activity line.** Summary grammar, collapsed by default, rows, reasoning folded in, failed count, subagent rows. | unit: summary strings for scripted turns; e2e: a scripted turn with 3 reads + 1 failed fetch shows one line `Read 3 notes · 1 failed` and expands to 4 rows |
| 4 | **Inline approval card.** Card, keyboard, background-tab dot, stop, resolved state, Dialog fallback setting. | e2e: `approval-deterministic` and `multi-tab-approval` pass against the card (no `.modal` in DOM); Enter allows, Esc denies |
| 5 | **Messages + turn actions.** Assistant without a bubble, user bubble, sources, per-turn meta, info cards. | e2e: per-turn meta present; global usage line gone; copy action works on touch viewport |
| 6 | **Composer + empty state.** Toolbar order, context ring %, status line, placeholder, suggestions. | e2e: clicking a suggestion fills the composer and doesn't send; context ring click runs `/context` |
| 7 | **Mobile pass + remaining modals restyle.** | `test:e2e:mobile`: 44px targets on tabs, send and approval buttons; long-press rename |
| 8 | **Cleanup.** Remove the Dialog fallback and `ApprovalModal` (if the owner agrees after a release), dead CSS, and the token-lint allowlist. Then propose an explore run. | Token lint allowlist is empty; `styles.css` line count reported before and after |

PRs 2 and 3 can run in parallel worktrees after PR 1. PR 4 depends on 3, because
the card attaches to the activity line.

## Decisions for the owner

These are proposals; say yes or change them on the PR.

1. **Tab limit: 8.** A higher limit costs memory (one agent service per tab),
   most of all on mobile.
2. **Approvals and errors in the summary line:** approvals auto-expand the line
   and show the card under it. Failed steps add a red `· N failed` but don't turn
   a finished turn red.
3. **Approval modal fallback:** keep a "Dialog" option for one release, then
   delete it in PR 8.
4. **Tabs move to the top.** The alternative is keeping them above the
   composer.
5. **Per-turn cost meta:** show it on hover, or only behind a setting.
