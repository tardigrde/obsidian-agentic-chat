# Chat turn

## Sub-features

- Submit a prompt and stream assistant text into the transcript.
- A reasoning section, markdown rendering, and a settled status pill.
- Inline tool-call step cards, edit diffs, and result rows.
- Stop the active turn.
- Queue a plain message while the agent runs.
- Live turn control: `/steer`, `/follow-up`, `/redirect`.
- Inline `ask_user` question with choices and a free-text answer.
- Per-turn actions: Copy response, Ask again, Implement this plan.
- An error banner with Retry.
- A vault path link on a tool step.
- Click a sent user turn to edit and resend it.
- A context-window bar, a usage readout, and a background-tab completion notice.

## How to get to it (user view)

- Type a prompt in the composer and press Enter, or click **Send**.
- While the agent responds, the send button changes to **Queue**, and **Stop**
  appears next to it.
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
| Send a prompt and render a reply | `src/ui/chat-view.ts:1533` | `test/e2e/specs/approval-deterministic.e2e.ts:311` | `covered` |
| Stream text deltas | `src/ui/chat-view.ts:2708` | `test/e2e/specs/beautifului-polish.e2e.ts:148` (synthetic stream) | `partial` |
| Reasoning section | `src/ui/chat-view.ts:2712` | `test/e2e/specs/beautifului-polish.e2e.ts:148` | `partial` |
| Markdown rendering | `src/ui/chat-view.ts:2723` | `test/assistant-bubble-rendering.test.ts:218` (unit only) | `partial` |
| Tool step cards and diffs | `src/ui/chat-view.ts:2681` | `test/e2e/specs/approval-deterministic.e2e.ts:329` | `covered` |
| Tool-step vault path link | `src/ui/assistant-bubble.ts:397` | no committed check | `NONE` |
| Stop the active turn (toolbar) | `src/ui/chat-view.ts:827` | `test/e2e/specs/skill-chip.e2e.ts:48` (click only) | `partial` |
| Stop one tab without aborting the other | `src/ui/chat-view.ts:834` | `test/e2e/specs/two-tab-stop.e2e.ts:131` | `covered` |
| Stop clears queued steering and follow-ups | `src/agent/agent-service.ts:711` | `test/agent-service.test.ts:1671` | `partial` |
| `/compact` skips when the session changed | `src/agent/agent-service.ts:562` | `test/agent-service.test.ts:1030` | `partial` |
| Compaction recovery stops the next prompt | `src/agent/prompt-turn-runtime.ts:64` | `test/agent-service.test.ts:1107` | `partial` |
| Queue a plain message | `src/ui/chat-view.ts:1329` | `test/e2e/specs/approval-deterministic.e2e.ts:456` | `covered` |
| `/steer` | `src/ui/chat-view.ts:1792` | `test/e2e/specs/approval-deterministic.e2e.ts:491` | `covered` |
| `/follow-up` | `src/ui/chat-view.ts:1733` | `test/turn-control.test.ts:98` (label and parser only) | `partial` |
| `/redirect` | `src/ui/chat-view.ts:1660` | `test/turn-control.test.ts:98` (label and parser only) | `partial` |
| Redirect survives a compacting turn | `src/agent/agent-service.ts:865` | `test/agent-service.test.ts:1606` | `partial` |
| Prompt is blocked when the session changes during preparation | `src/agent/prompt-turn-runtime.ts:63` | `test/agent-service.test.ts:1155` | `partial` |
| Inline `ask_user` card | `src/ui/chat-view.ts:570` | `test/chat-view-ask-user.test.ts:82` (unit only) | `partial` |
| Ctrl/Cmd+Enter sends an ask-user answer | `src/ui/chat-view.ts:629` | no committed check | `NONE` |
| Copy response | `src/ui/assistant-bubble.ts:827` | no committed check | `NONE` |
| Ask again | `src/ui/assistant-bubble.ts:813` | no committed check | `NONE` |
| Implement this plan | `src/ui/chat-view.ts:2752` | no committed check | `NONE` |
| Error banner Retry | `src/ui/assistant-bubble.ts:783` | no committed check | `NONE` |
| Edit and resend a user turn | `src/ui/chat-view.ts:2635` | `test/prompt-edit-state.test.ts:5` (state only) | `partial` |
| Context-window bar | `src/ui/chat-view.ts:775` | `test/e2e/specs/smoke.e2e.ts:179` (existence only) | `partial` |
| Usage readout | `src/ui/chat-view.ts:2216` | no committed check | `NONE` |
| Background-tab completion notice | `src/ui/chat-view.ts:1254` | no committed check | `NONE` |

## Gotchas

- Streamed text grows. Wait for a stable non-empty value, not a fixed string.
- A denied tool call still needs its follow-up scripted turn.
- The transcript grows across tests. Scope to the latest assistant turn or reset.
- `ask_user` requires a non-empty answer. The card detaches after it settles.
- "Ask again" re-runs the last user prompt. "Retry" appears only for failures
  with no text. A turn with text and an error uses the action row instead.
- "Implement this plan" appears only in plan mode and only when the reply ends
  with the `PLAN_COMPLETE` marker.
- The plugin no longer shows a per-turn usage footer. Usage is in the bottom bar
  and `/usage`.
