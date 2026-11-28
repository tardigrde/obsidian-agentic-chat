# Chat turn

## Sub-features

- Submit a prompt and stream assistant text into the transcript.
- A reasoning section, markdown rendering, and a settled status pill.
- Inline tool-call step cards, edit diffs, and result rows.
- Stop the active turn.
- One composer delivery path: Enter sends or steers, Shift+Enter adds a newline,
  Queue holds a draft, and Stop then send replaces the turn.
- Inline `ask_user` question with choices and a free-text answer.
- Per-turn actions: Copy response, Ask again.
- Vault images (`![[pic.png]]`, vault-relative `![](path)`) render inline in
  replies; attached images show as thumbnails in the user bubble.
- An error banner with Retry.
- A vault path link on a tool step.
- Click a sent user turn to edit and resend it.
- A context-window bar, a usage readout, and a background-tab completion notice.

## How to get to it (user view)

- Type a prompt in the composer and press Enter, or click **Send**, while the
  agent is idle.
- While the agent responds, Enter steers the active turn and the send button
  changes to **Queue**. **Queue** holds the draft until the turn ends. **Stop**
  appears next to it; stop, then send, replaces the turn.
- Assistant turns show their actions under the text.
- `ask_user` renders a question card in the transcript.
- Click a sent user message to load it back into the composer. Enter resends;
  Escape cancels.

## Driving it with the probe harness

```ts
await browser.executeObsidianCommand("agentic-chat:open-chat");
await $(".agentic-chat-input").setValue("hello");
await $(".agentic-chat-send").click();

await browser.waitUntil(async () =>
  (await $(".agentic-chat-assistant .agentic-chat-text").getText()).length > 0,
);
```

- Deterministic: install scripted turns with `installScriptedTurns()` as
  `test/e2e/specs/approval-deterministic.e2e.ts` does.
- Live: configure `openai-compatible` with the three `AGENTIC_CHAT_*`
  environment variables, as `test/e2e/live/openwebui-live.e2e.ts` does.
- Approval: wait for `.agentic-chat-approval`, then `button=Allow` or
  `button=Deny`.
- Side effect: `browser.executeObsidian(({ app, obsidian }, path) => ...)`.
- Activity line: `[data-ac="activity"]` (`data-ac-state` running, needs-you,
  done, error), `activity-head` (`aria-expanded`), `activity-body`, and one
  `[data-ac="step"]` row per tool call (`data-ac-state` running, done, error).
  The body is collapsed by default, so its text is not in `innerText`.

## Proof

| entry point | source | proof | status |
|---|---|---|---|
| Send a prompt and render a reply | `src/ui/chat-turn.ts#submit` | `test/e2e/specs/composer-paths.e2e.ts#sends with Enter while the agent is idle` | `covered` |
| Stream text deltas | `src/ui/transcript-view.ts#renderTranscript` | `test/ui/chat-render.test.ts#folds reasoning in as the first body entry, settled with its time` (synthetic stream) | `partial` |
| Reasoning folds into the activity line, one row per model call in event order | `src/ui/activity-line.ts#ReasoningEntry` | `test/e2e/specs/chat-ui-u3.e2e.ts#U3 #5 #3 #4: one spinner per turn; thoughts in event order; a folder is never a note link`; `test/ui/chat-render.test.ts#folds reasoning in as the first body entry, settled with its time` | `covered` |
| A thought row folds to one head (`Thought 2s`), nothing clipped or overlapping; a click opens the trace | `src/ui/activity-line.ts#ReasoningEntry` | `test/e2e/specs/timeline-u4.e2e.ts#U4 #2 #3: a thought row is one head (Thought + time), nothing clipped, nothing overlapping` | `covered` |
| One activity line per run of steps: text, tool, text keeps its order, live and on replay | `src/ui/transcript-view.ts#openSegment` | `test/e2e/specs/timeline-u4.e2e.ts#U4 #1: text, tool, text reads in that order, live and after a re-render`; `test/ui/transcript-order.test.ts#text, tool, text reads in that order, live and after a re-render` | `covered` |
| One activity line per segment, `· N failed`, rows on expand | `src/ui/activity-line.ts#ActivityLine` | `test/e2e/specs/activity-line.e2e.ts#shows one collapsed line per turn and four rows when expanded` | `covered` |
| One spinner while a turn runs (the activity line; no "Working…" line, U7 #2) | `src/ui/chat-chrome.ts#setRunning` | `test/e2e/specs/chat-ui-u3.e2e.ts#U3 #5 #3 #4: one spinner per turn; thoughts in event order; a folder is never a note link` | `covered` |
| Activity summary grammar | `src/ui/activity-summary.ts#summarizeSteps` | `test/activity-summary.test.ts#groups verbs in the order they first happen and merges counts` (unit) | `partial` |
| Markdown rendering | `src/ui/assistant-bubble.ts#MarkdownRenderer.render` | `test/ui/assistant-bubble-rendering.test.ts#converts Obsidian callout blockquotes when MarkdownRenderer leaves them plain` (unit only) | `partial` |
| Tool step rows and diffs | `src/ui/activity-line.ts#startStep` | `test/e2e/specs/approval-deterministic.e2e.ts#asks before a scripted edit and undo restores the prior text` | `covered` |
| Tool-step vault path link; a folder is plain text with a folder icon and never creates a note | `src/ui/vault-open.ts#openVaultPath`; `src/ui/activity-line.ts#startStep` | `test/e2e/specs/chat-ui-u3.e2e.ts#U3 #5 #3 #4: one spinner per turn; thoughts in event order; a folder is never a note link` | `covered` |
| Stop the active turn (Escape in the composer; Stop on an empty draft) | `src/ui/chat-view.ts#stopActiveTurn`; `src/ui/chat-layout.ts#buildLayout` | `test/e2e/specs/composer-paths.e2e.ts#stops, then sends the draft as a replacement turn`; `test/e2e/specs/timeline-u4.e2e.ts#Stop/Queue: one round button (Stop on an empty draft, Queue with text); Escape stops` | `covered` |
| Stop one tab without aborting the other | `src/ui/chat-view.ts#buildLayout` | `test/e2e/specs/two-tab-stop.e2e.ts#stopping one tab does not abort the other tab's turn` | `covered` |
| Stop clears queued steering | `src/agent/steering-queue.ts#stop(agent: Agent)` | `test/agent-service.test.ts#clears queued steering when the spend cap stops a run` (unit only) | `partial` |
| `/compact` skips when the session changed | `src/agent/conversation-compaction.ts#runManual` | `test/agent-service.test.ts#reloads the persisted transcript when compaction cannot replace the live agent` | `partial` |
| `/compact` summarizes all but the latest turn, keeps its bubble, and shows one Compact card (result and folded summary) where the compaction ran | `src/ui/slash/session.ts#runCompact`; `src/agent/compaction-runtime.ts#performCompaction` | `test/ui/slash-compact.test.ts#keeps the command bubble after the transcript redraw`; `test/compaction-runtime.test.ts#manual compaction keeps the latest turn instead of filling the automatic keep budget`; `test/compaction.test.ts#reports conversation tokens before and after, the context load, and the fixed overhead`; `test/e2e/specs/smoke.e2e.ts#shows the compaction summary inside the Compact card below the kept turn` | `covered` |
| Compaction recovery stops the next prompt | `src/agent/conversation-compaction.ts#runAutomatic` | `test/agent-service.test.ts#blocks a prompt when the session changes during turn preparation` | `partial` |
| Enter sends while idle | `src/ui/composer-input.ts#resolveComposerAction` | `test/e2e/specs/composer-paths.e2e.ts#sends with Enter while the agent is idle` | `covered` |
| Enter steers after the current model turn | `src/ui/composer-input.ts#resolveComposerAction` | `test/e2e/specs/composer-paths.e2e.ts#steers after a successful tool call while the agent is running` | `covered` |
| Undelivered steering returns to the composer | `src/ui/chat-tabs.ts#restoreUndeliveredSteers` | `test/agent-service.test.ts#clears queued steering when the user stops the active run`, `test/composer-input.test.ts#strips one leading context preamble for retry display` (unit only) | `partial` |
| Shift+Enter inserts a newline | `src/ui/chat-view.ts#buildLayout` | `test/e2e/specs/composer-paths.e2e.ts#inserts a newline with Shift+Enter without sending` | `covered` |
| Queue holds a draft until the turn ends; an empty draft shows Stop in its place (one round button) | `src/ui/chat-chrome.ts#syncSendAvailability` | `test/e2e/specs/composer-queue.e2e.ts#Stop on an empty draft, Queue once the user types; the chip sends the draft after the turn`; `test/e2e/specs/composer-paths.e2e.ts#holds the Queue action until the active turn ends` | `covered` |
| Closing the pane mid-turn saves the stopped turn | `src/agent/agent-service.ts#disposeAfterStop` | `test/ui/chat-sessions.test.ts#U3 #13: closing the view mid-turn records the stopped turn, so the session has no turn without an end` (happy-dom; no real-app close) | `partial` |
| Stop then send replaces the turn | `src/ui/chat-view.ts#stopActiveTurn` | `test/e2e/specs/composer-paths.e2e.ts#stops, then sends the draft as a replacement turn` | `covered` |
| Prompt is blocked when the session changes during preparation | `src/agent/prompt-turn-runtime.ts#async run(run: PromptTurnRun` | `test/agent-service.test.ts#blocks a prompt when the session changes during turn preparation` | `partial` |
| Inline `ask_user` card | `src/ui/chat-view.ts#renderAskUserPrompt` | `test/ui/chat-ask-user.test.ts#shows the question and choices, and a choice answers and removes the card` | `covered` |
| An answered question stays after the text written before it | `src/ui/assistant-bubble.ts#renderAnsweredQuestion` | `test/e2e/specs/chat-ui-u3.e2e.ts#U3 #15: the question shows after the text written before it` | `covered` |
| Ctrl/Cmd+Enter sends an ask-user answer | `src/ui/chat-view.ts#renderAskUserPrompt` | `test/ui/chat-ask-user.test.ts#Ctrl+Enter sends a typed answer; an empty answer is not sent` | `covered` |
| Copy response | `src/ui/assistant-bubble.ts#actionButton` | no committed check | `NONE` |
| Ask again | `src/ui/assistant-bubble.ts#actionButton` | `test/chat-view-retry.test.ts#ChatView retry` (unit only) | `partial` |
| Retry keeps image attachments | `src/ui/chat-view.ts#retryLast` | `test/chat-view-retry.test.ts#ChatView retry` (unit only) | `partial` |
| Vault images render inline in replies | `src/ui/assistant-bubble.ts#finalizeText` | `test/ui/chat-render.test.ts#renders vault image embeds in assistant markdown and leaves code untouched` | `covered` |
| User bubble image thumbnails; click opens the vault image | `src/ui/transcript-view.ts#renderUserMessage` | `test/ui/chat-render.test.ts#shows one openable thumbnail per attached image and does not echo the sent user turn`, `test/ui/chat-render.test.ts#renders a replayed vision block as a data-URL thumbnail` | `covered` |
| Error banner Retry | `src/ui/assistant-bubble.ts#showError` | `test/ui/chat-view-states.test.ts#streaming -> error -> idle: the error shows once in the bubble with Ask again` (happy-dom) | `partial` |
| Edit and resend a user turn | `src/ui/chat-turn.ts#editAndResend` | `test/prompt-edit-state.test.ts#starts editing a prompt and restores the original draft on cancel` (state only) | `partial` |
| Context ring and breakdown tooltip | `src/ui/chat-chrome.ts#syncContextRing` | `test/context-bar.test.ts#is high at 90% and above` (levels); `test/context-breakdown.test.ts#splits the system prompt, tools, and conversation; deferred tools count as 0 tokens` (breakdown) | `partial` |
| Usage readout | `src/ui/slash/info.ts#showUsage` | no committed check | `NONE` |
| Background-tab completion notice | `src/ui/chat-tabs.ts#handleTabEvent` | no committed check | `NONE` |

## Gotchas

- Streamed text grows. Wait for a stable non-empty value, not a fixed string.
- A denied tool call still needs its follow-up scripted turn.
- The transcript grows across tests. Scope to the latest assistant turn or reset.
- `ask_user` requires a non-empty answer. The card detaches after it settles.
- "Ask again" re-runs the last user prompt. "Retry" appears only for failures
  with no text. A turn with text and an error uses the action row instead.
- The plugin no longer shows a per-turn usage footer. Usage is in the bottom bar
  and `/usage`.
