# Slash commands

## Sub-features

- Local commands that never call the model: `/help`, `/compact`, `/undo`, `/plan`,
  `/endplan`, `/dirs`, `/add-dir`, `/todo`, `/config`, `/effort`, `/memory`.
- `/init` injects standing instructions and keeps the full command text visible.
- Model commands: `/steer`, `/follow-up`, `/redirect`.
- Command autocomplete in the composer.

## How to get to it (user POV)

Type `/` in the composer. Autocomplete opens; Enter submits. All commands run
through the same composer send path as a normal prompt.

## Driving it with the probe harness

```ts
await browser.execute((value) => {
  const textarea = document.querySelector<HTMLTextAreaElement>(".agentic-chat-input");
  const send = document.querySelector<HTMLButtonElement>(".agentic-chat-send");
  if (!textarea || !send) throw new Error("composer is not mounted");
  textarea.value = value;
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  send.click();
}, "/help");

await $(".agentic-chat-info").waitForExist();
```

Use the click path instead of synthesized Enter. It exercises the same submit route
and avoids version-specific key handling.

Committed proof: `test/e2e/specs/smoke.e2e.ts`.

## Gotchas

- Local commands must not hit the network. Assert that no model call happened, not
  just that the info block appeared.
- `/init` keeps the full command text in the transcript and clears the composer.
- `/compact` accepts tail instructions; the tail is guidance, not a prompt.
- `/plan` is sticky. Pair it with `/endplan` in the same scenario or later cases
  inherit read-only mode.
- The `.agentic-chat-info` element may already exist from an earlier command. Assert
  the new text, not existence alone.
