# Chat turn

## Sub-features

- Composer card with a tab strip and textarea.
- Active-note and drag-and-drop attachments.
- Streaming assistant text, reasoning section, and markdown rendering.
- Tool-call step cards, diffs, and approval prompts.
- `/undo` for the last vault mutation.
- Queued follow-ups, `/steer`, and `/redirect`.
- Session tabs, history, rename, export.

## How to get to it (user POV)

- Ribbon icon, or command palette: `Agentic Chat: Open chat`.
- Programmatically: `browser.executeObsidianCommand("agentic-chat:open-chat")`.
- Existing session: the tab strip inside the chat view, or the history menu.

## Driving it with the probe harness

```ts
await browser.executeObsidianCommand("agentic-chat:open-chat");
await $(".agentic-chat-view").waitForExist();

await $(".agentic-chat-input").setValue("hello");
await $(".agentic-chat-send").click();

await browser.waitUntil(async () =>
  (await $(".agentic-chat-assistant .agentic-chat-text").getText()).length > 0,
);
```

- Deterministic: install `window.__AGENTIC_CHAT_E2E_TURNS__` with scripted turns,
  as `test/e2e/specs/approval-deterministic.e2e.ts` does.
- Live: configure `openai-compatible` with `AGENTIC_CHAT_API_KEY`,
  `AGENTIC_CHAT_BASE_URL`, and `AGENTIC_CHAT_MODEL`, as
  `test/e2e/specs/openwebui-live.e2e.ts` does.
- Approval: `.agentic-chat-approval`, then `button=Allow` or `button=Deny`.
- Vault side effect: `browser.executeObsidian(({ app, obsidian }, path) => ...)`.

Committed proof: `test/e2e/specs/smoke.e2e.ts`,
`test/e2e/specs/approval-deterministic.e2e.ts`,
`test/e2e/specs/runtime-behavior.e2e.ts`.

## Gotchas

- `setValue` alone does not submit. Click `.agentic-chat-send` or press Enter.
- Streamed text grows. Wait for a stable non-empty value, not a fixed string.
- A denied tool call still consumes its follow-up scripted turn.
- The transcript keeps growing across tests. Scope selectors to the latest turn or
  reset between cases.
- Approval copy can change. Prefer the class and button role over exact prose.
