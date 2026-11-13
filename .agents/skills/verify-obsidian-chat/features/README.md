# Feature map

This directory maps every user path into Agentic Chat to its committed proof. It
is the audit index for [SKILL.md](../SKILL.md). The map has eight journey files.
Each one keeps the same five sections, in this order:

1. `## Sub-features`
2. `## How to get to it (user view)`
3. `## Driving it with the probe harness`
4. `## Proof`
5. `## Gotchas`

## Journeys

| Journey | Covers |
|---|---|
| [Open and compose](./open-and-compose.md) | Ribbon, commands, context menus, composer keys, autocomplete entry, attachments, Quick Ask. |
| [Chat turn](./chat-turn.md) | Streaming output, reasoning, tool steps, stop, queue, composer steering, ask-user, copy/retry, prompt edit. |
| [Approval and permissions](./approval-and-permissions.md) | Approval modal, allow/deny/remember, approval policies, Safe/YOLO. |
| [Sessions and tabs](./sessions-and-tabs.md) | Tabs, new chat, history, rename, delete, export, persistence. |
| [Commands and skills](./commands-and-skills.md) | Slash command catalog, autocomplete behavior, skill loading, skill tools, New skill modal. |
| [Settings](./settings.md) | Three settings tabs (Models, Agent, Advanced), secrets, conditional fields, plugin rows. |
| [MCP and OAuth](./mcp-and-oauth.md) | MCP servers, auth modes, OAuth sign-in, tool discovery, plugin-provided MCP. |
| [Subagents and context](./subagents-and-context.md) | `/agent`, the `subagent` tool, child status and stop, context serialization and budgets. |

## Shared preconditions

- Build before you assert. `npm run verify -- e2e <spec>` rebuilds the e2e
  bundle. `npm run probe -- --scenario <name>` rebuilds by default.
- Use the throwaway sandbox vault that the runner creates, not `~/MyTestVault`.
- Real Obsidian settings open in a popout window on Obsidian 1.13 and later.
  Use `test/e2e/support/settings-ui.ts`; do not query the main window.
- For deterministic turns, install `window.__AGENTIC_CHAT_E2E_TURNS__` with
  `installScriptedTurns()`. The plugin reaches it through
  `createWindowE2EStreamFn` in `src/agent/e2e-stream.ts:34`.
- Live turns need `AGENTIC_CHAT_API_KEY`, `AGENTIC_CHAT_BASE_URL`, and
  `AGENTIC_CHAT_MODEL`. A live spec skips without them and still exits 0. Read
  the test counts.
- This audit records source references as `path:line`. `refs.lock.json` pins the
  trimmed text of every referenced line, so a ref that drifts to the wrong
  non-blank line fails. The checker rejects a missing file, an out-of-range
  line, a blank line, and a line whose text differs from the lock.

## Proof rules

- `covered`: a committed e2e, replay, probe, or real user-action check drives the
  named entry point and asserts the user-visible outcome or the vault side
  effect. A unit test alone is `partial`. A live spec that skips without keys, a
  dogfood spec, and a helper are not `covered` either.
- `partial`: the check covers a component of the path, one variant, or only a
  gated path. A unit-only or policy-only check belongs here. The table says what
  is missing.
- `NONE`: no committed check drives this user action. The source exists, but the
  proof does not.
- `unreachable`: the code path has no production caller. The table says why.

Do not treat source code as proof. Do not cite a spec for a behavior it does not
assert. A skipped live spec is not a pass. A screenshot is not a verdict. Proof
paths must exist in the repository.

## Status legend

| Status | Meaning |
|---|---|
| `covered` | Exact user action is driven and asserted by a committed user-action check. |
| `partial` | Only a unit test, a component, one variant, or a gated check exists. |
| `NONE` | No committed proof for the user action. |
| `unreachable` | No production caller, or the code path is a stub. |

## Updating this map

- Add or move a row when an entry point is added or removed.
- Keep the source reference on the line that creates the control or handles the
  action, not on an import or a type.
- Keep one journey as the single place that documents a behavior. Other
  journeys may link to it instead of repeating the proof table.
- Run `npm run check:feature-map` after any edit. It checks the five sections,
  the table shape, the status values, every `path:line`, and its locked text. It
  also enumerates the command ids, slash commands, and literal settings rows in
  the source and fails when one is not named in a proof row. It runs in `ci` and
  `fast`.
- A drifted ref: run `npm run fix:feature-map`. For each ref whose text no
  longer matches, it finds the locked text again, first in the same file
  (nearest exact match), then as a unique exact match under `src/` or `test/`.
  It rewrites the markdown and the lock key, prints every move, and prints every
  ref it could not place. Those stay failing. `--fix` never moves a ref whose
  text still matches.
- After an intended move, adopt the new lines with
  `npm run fix:feature-map -- --write-lock`. The merge procedure is: take main's
  `features/` directory (map and lock), then run `--fix`.
- An entry point that must stay out of the map goes in the checker's
  `INVENTORY_ALLOWLIST` with a one-line reason.
- The checker cannot judge whether a test asserts the user action. A reviewer
  owns that judgment; a wrong `covered` is still a review finding.

## Break-change

Before a product-cut PR, run `@break-change`. Targeted mode attacks the changed
entrypoints. Removal mode proves a deleted command or UI entrypoint is absent
from `/help`, the registry, the UI, docs, this map, imports, and routes. General
mode lists `partial` and `NONE` rows and targets a small high-risk subset.

A break-change report is a lead, not a proof. It does not upgrade a row. Promote a
confirmed finding into a committed user-action check, then update the table.
