# 0010 — Prompt context is escaped, deduped by complete section, and never includes private notes

- Status: Accepted
- Date: 2026-11-22

## Decision

Images go to the model as multimodal parts, never as text in the context block. Attacker-controllable
attachment text is escaped at the join, so it cannot close a context wrapper or forge a `Focus:` hint.

Dedupe removes only a complete delimiter-wrapped section. A focused note that matches the ignore/private
rules is never sent: no path, title, or content, in the prompt or in attachments. This holds at context
assembly, not only in the UI.

## Why

Delimiters are the only boundary the model can see, so a document that closes them can forge
instructions. Partial dedupe can suppress a section that shares a sentence with another, and a private
path in the prompt is already a leak.

## Consequences

- `src/ui/context-builder.ts` owns escaping, section dedupe, and image parts.
- `src/ui/active-note.ts` and `src/ui/context-chip-renderer.ts` must agree on the private-note decision.
- A new context source returns a delimited section through the same builder.

## Links

- `src/ui/context-builder.ts`
- `src/ui/active-note.ts`
- `test/ui/private-content.test.ts`
- `docs/guide/privacy.md`
