# 0010 — Prompt context is escaped, deduped by complete section, and never includes private notes

- Status: Accepted
- Date: 2026-11-22

## Decision

Image attachments go to the model as multimodal content parts, never as text
inside the context block.

Attacker-controllable attachment text is escaped before it enters a context
wrapper: `</context>`, `<context>`, and `Focus:` are backslash-escaped so a
pasted document cannot close the wrapper or forge a focus hint.

Context is deduped only on a complete delimiter-wrapped section. A bare
substring match is not enough: the same words may appear in a note the user
actually attached, and replacing that with a stub would lose real content.

A focused note that matches the ignore/private rules is never sent. The composer
shows a lock chip; the path, title, and content stay out of the prompt and out of
attachments. This is enforced at context assembly, not only in the UI.

## Why

The prompt is a string built from several sources, some of them untrusted (vault
content, fetched pages, pasted text). Delimiters are the only boundary the model
can see, so a document that can close them can forge instructions. Escaping at
the join is cheaper and safer than trusting every upstream extractor.

Dedupe by complete section avoids a subtle privacy and correctness failure:
partial matching can suppress a section because a different section happens to
contain the same sentence, or because the boundary changed. The stub is only
valid when the whole delimited block is unchanged.

Private notes are a hard boundary. The user configured them to be invisible; a
lock chip is the only acknowledgement. A path in the prompt is already a leak,
even if the body is omitted.

## Consequences

- `src/ui/context-builder.ts` owns escaping, section dedupe, and image parts.
- `src/ui/active-note.ts` and `src/ui/context-chip-renderer.ts` own the private
  note decision; both must agree.
- A new context source must return a delimited section and go through the same
  builder. Do not concatenate a new wrapper directly.
- `test/ui/private-content.test.ts` and the context-builder tests pin the
  boundary.

## Links

- `src/ui/context-builder.ts`
- `src/ui/active-note.ts`
- `src/ui/context-attachments.ts`
- `test/context-builder.test.ts`
- `test/ui/private-content.test.ts`
- `docs/guide/privacy.md`
