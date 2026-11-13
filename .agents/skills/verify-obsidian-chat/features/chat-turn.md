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
| Send a prompt and render a reply | `src/ui/chat-view.ts:1241` | `test/e2e/specs/composer-paths.e2e.ts:159` | `covered` |
| Stream text deltas | `src/ui/transcript-view.ts:174` | `test/e2e/specs/beautifului-polish.e2e.ts:148` (synthetic stream) | `partial` |
| Reasoning section | `src/ui/transcript-view.ts:332` | `test/e2e/specs/beautifului-polish.e2e.ts:148` | `partial` |
| Markdown rendering | `src/ui/transcript-view.ts:341` | `test/assistant-bubble-rendering.test.ts:218` (unit only) | `partial` |
| Tool step cards and diffs | `src/ui/transcript-view.ts:180` | `test/e2e/specs/approval-deterministic.e2e.ts:337` | `covered` |
| Tool-step vault path link | `src/ui/assistant-bubble.ts:427` | no committed check | `NONE` |
| Stop the active turn (toolbar) | `src/ui/chat-view.ts:1215` | `test/e2e/specs/composer-paths.e2e.ts:234` | `covered` |
| Stop one tab without aborting the other | `src/ui/chat-view.ts:781` | `test/e2e/specs/two-tab-stop.e2e.ts:131` | `covered` |
| Stop clears queued steering | `src/agent/agent-service.ts:768` | `test/agent-service.test.ts:1598` (unit only) | `partial` |
| `/compact` skips when the session changed | `src/agent/agent-service.ts:640` | `test/agent-service.test.ts:970` | `partial` |
| Compaction recovery stops the next prompt | `src/agent/prompt-turn-runtime.ts:64` | `test/agent-service.test.ts:1107` | `partial` |
| Enter sends while idle | `src/ui/composer-input.ts:22` | `test/e2e/specs/composer-paths.e2e.ts:159` | `covered` |
| Enter steers after the current model turn | `src/ui/composer-input.ts:22` | `test/e2e/specs/composer-paths.e2e.ts:174` | `covered` |
| Undelivered steering returns to the composer | `src/ui/chat-view.ts:2357` | `test/agent-service.test.ts:1517`, `test/composer-input.test.ts:29` (unit only) | `partial` |
| Shift+Enter inserts a newline | `src/ui/chat-view.ts:671` | `test/e2e/specs/composer-paths.e2e.ts:275` | `covered` |
| Queue holds a draft until the turn ends | `src/ui/chat-view.ts:1221` | `test/e2e/specs/composer-paths.e2e.ts:208` | `covered` |
| Stop then send replaces the turn | `src/ui/chat-view.ts:1215` | `test/e2e/specs/composer-paths.e2e.ts:234` | `covered` |
| Prompt is blocked when the session changes during preparation | `src/agent/prompt-turn-runtime.ts:63` | `test/agent-service.test.ts:1155` | `partial` |
| Inline `ask_user` card | `src/ui/chat-view.ts:515` | `test/chat-view-ask-user.test.ts:82` (unit only) | `partial` |
| Ctrl/Cmd+Enter sends an ask-user answer | `src/ui/chat-view.ts:573` | no committed check | `NONE` |
| Copy response | `src/ui/assistant-bubble.ts:865` | no committed check | `NONE` |
| Ask again | `src/ui/assistant-bubble.ts:851` | `test/chat-view-retry.test.ts:152` (unit only) | `partial` |
| Retry keeps image attachments | `src/ui/chat-view.ts:1451` | `test/chat-view-retry.test.ts:152` (unit only) | `partial` |
| Vault images render inline in replies | `src/ui/assistant-bubble.ts:743` | `test/e2e/specs/inline-images.e2e.ts:55` | `covered` |
| User bubble image thumbnails; click opens the vault image | `src/ui/transcript-view.ts:193` | `test/e2e/specs/inline-images.e2e.ts:86`, `test/e2e/specs/inline-images.e2e.ts:154` | `covered` |
| Error banner Retry | `src/ui/assistant-bubble.ts:821` | `test/chat-view-retry.test.ts:152` (unit only) | `partial` |
| Edit and resend a user turn | `src/ui/chat-view.ts:2335` | `test/prompt-edit-state.test.ts:5` (state only) | `partial` |
| Context-window bar | `src/ui/chat-view.ts:723` | `test/e2e/probe/scenarios/context-readout.e2e.ts:47` | `covered` |
| Usage readout | `src/ui/chat-view.ts:1983` | no committed check | `NONE` |
| Background-tab completion notice | `src/ui/chat-view.ts:1215` | no committed check | `NONE` |

## Gotchas

- Streamed text grows. Wait for a stable non-empty value, not a fixed string.
- A denied tool call still needs its follow-up scripted turn.
- The transcript grows across tests. Scope to the latest assistant turn or reset.
- `ask_user` requires a non-empty answer. The card detaches after it settles.
- "Ask again" re-runs the last user prompt. "Retry" appears only for failures
  with no text. A turn with text and an error uses the action row instead.
- The plugin no longer shows a per-turn usage footer. Usage is in the bottom bar
  and `/usage`.
