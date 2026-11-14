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
  environment variables, as `test/e2e/specs/openwebui-live.e2e.ts` does.
- Approval: wait for `.agentic-chat-approval`, then `button=Allow` or
  `button=Deny`.
- Side effect: `browser.executeObsidian(({ app, obsidian }, path) => ...)`.
- Tool steps: `.agentic-chat-tool`, `.agentic-chat-diff-line.is-add`,
  `.agentic-chat-diff-line.is-del`.

## Proof

| entry point | source | proof | status |
|---|---|---|---|
| Send a prompt and render a reply | `src/ui/chat-turn.ts#submit` | `test/e2e/specs/composer-paths.e2e.ts#sends with Enter while the agent is idle` | `covered` |
| Stream text deltas | `src/ui/transcript-view.ts#renderTranscript` | `test/e2e/specs/beautifului-polish.e2e.ts#live reasoning settles to Thought with a final elapsed timer once the answer streams` (synthetic stream) | `partial` |
| Reasoning section | `src/ui/transcript-view.ts#updateScrollPinning` | `test/e2e/specs/beautifului-polish.e2e.ts#live reasoning settles to Thought with a final elapsed timer once the answer streams` | `partial` |
| Markdown rendering | `src/ui/assistant-bubble.ts#MarkdownRenderer.render` | `test/assistant-bubble-rendering.test.ts#converts Obsidian callout blockquotes when MarkdownRenderer leaves them plain` (unit only) | `partial` |
| Tool step cards and diffs | `src/ui/transcript-view.ts#renderTranscript` | `test/e2e/specs/approval-deterministic.e2e.ts#asks before a scripted edit and undo restores the prior text` | `covered` |
| Tool-step vault path link | `src/ui/step-card.ts#appendPathLink` | no committed check | `NONE` |
| Stop the active turn (toolbar) | `src/ui/chat-view.ts#stopActiveTurn` | `test/e2e/specs/composer-paths.e2e.ts#stops, then sends the draft as a replacement turn` | `covered` |
| Stop one tab without aborting the other | `src/ui/chat-view.ts#buildLayout` | `test/e2e/specs/two-tab-stop.e2e.ts#stopping one tab does not abort the other tab's turn` | `covered` |
| Stop clears queued steering | `src/agent/steering-queue.ts#stop(agent: Agent)` | `test/agent-service.test.ts#clears queued steering when the spend cap stops a run` (unit only) | `partial` |
| `/compact` skips when the session changed | `src/agent/conversation-compaction.ts#runManual` | `test/agent-service.test.ts#reloads the persisted transcript when compaction cannot replace the live agent` | `partial` |
| Compaction recovery stops the next prompt | `src/agent/conversation-compaction.ts#runAutomatic` | `test/agent-service.test.ts#blocks a prompt when the session changes during turn preparation` | `partial` |
| Enter sends while idle | `src/ui/composer-input.ts#resolveComposerAction` | `test/e2e/specs/composer-paths.e2e.ts#sends with Enter while the agent is idle` | `covered` |
| Enter steers after the current model turn | `src/ui/composer-input.ts#resolveComposerAction` | `test/e2e/specs/composer-paths.e2e.ts#steers after a successful tool call while the agent is running` | `covered` |
| Undelivered steering returns to the composer | `src/ui/chat-tabs.ts#restoreUndeliveredSteers` | `test/agent-service.test.ts#clears queued steering when the user stops the active run`, `test/composer-input.test.ts#strips one leading context preamble for retry display` (unit only) | `partial` |
| Shift+Enter inserts a newline | `src/ui/chat-view.ts#buildLayout` | `test/e2e/specs/composer-paths.e2e.ts#inserts a newline with Shift+Enter without sending` | `covered` |
| Queue holds a draft until the turn ends | `src/ui/chat-view.ts#queueComposerPrompt` | `test/e2e/specs/composer-paths.e2e.ts#holds the Queue action until the active turn ends` | `covered` |
| Stop then send replaces the turn | `src/ui/chat-view.ts#stopActiveTurn` | `test/e2e/specs/composer-paths.e2e.ts#stops, then sends the draft as a replacement turn` | `covered` |
| Prompt is blocked when the session changes during preparation | `src/agent/prompt-turn-runtime.ts#async run(run: PromptTurnRun` | `test/agent-service.test.ts#blocks a prompt when the session changes during turn preparation` | `partial` |
| Inline `ask_user` card | `src/ui/chat-view.ts#renderAskUserPrompt` | `test/chat-view-ask-user.test.ts#ChatView ask_user prompt` (unit only) | `partial` |
| Ctrl/Cmd+Enter sends an ask-user answer | `src/ui/chat-view.ts#renderAskUserPrompt` | no committed check | `NONE` |
| Copy response | `src/ui/assistant-bubble.ts#actionButton` | no committed check | `NONE` |
| Ask again | `src/ui/assistant-bubble.ts#actionButton` | `test/chat-view-retry.test.ts#ChatView retry` (unit only) | `partial` |
| Retry keeps image attachments | `src/ui/chat-view.ts#retryLast` | `test/chat-view-retry.test.ts#ChatView retry` (unit only) | `partial` |
| Vault images render inline in replies | `src/ui/assistant-bubble.ts#finalizeText` | `test/e2e/specs/inline-images.e2e.ts#renders vault image embeds in assistant markdown and leaves code untouched` | `covered` |
| User bubble image thumbnails; click opens the vault image | `src/ui/transcript-view.ts#renderUserMessage` | `test/e2e/specs/inline-images.e2e.ts#shows one thumbnail per attached image on a live send`, `test/e2e/specs/inline-images.e2e.ts#renders a replayed vision block as a thumbnail` | `covered` |
| Error banner Retry | `src/ui/assistant-bubble.ts#showError` | `test/chat-view-retry.test.ts#ChatView retry` (unit only) | `partial` |
| Edit and resend a user turn | `src/ui/chat-turn.ts#editAndResend` | `test/prompt-edit-state.test.ts#starts editing a prompt and restores the original draft on cancel` (state only) | `partial` |
| Context-window bar | `src/ui/chat-view.ts#buildLayout` | `test/e2e/probe/scenarios/context-readout.e2e.ts#shows the full-load percentage with a section breakdown` | `covered` |
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
