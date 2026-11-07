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
| [Chat turn](./chat-turn.md) | Streaming output, reasoning, tool steps, stop, queue, composer steering, ask-user, copy/retry/implement, prompt edit. |
| [Approval and permissions](./approval-and-permissions.md) | Approval modal, allow/deny/remember, approval policies, working directories, Safe/YOLO/Plan. |
| [Sessions and tabs](./sessions-and-tabs.md) | Tabs, new chat, history, rename, delete, export, persistence. |
| [Commands and skills](./commands-and-skills.md) | Slash command catalog, autocomplete behavior, skill loading, skill tools, New skill modal. |
| [Settings](./settings.md) | All eight settings tabs, secrets, conditional fields, plugin rows. |
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
- This audit records source references as `path:line`. The checker rejects a
  missing file, an out-of-range line, and a blank line. Re-check the semantic
  anchor when the code moves.

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
  the table shape, the status values, and every `path:line`. It runs in `ci` and
  `fast`.
- The checker cannot judge whether a test asserts the user action. A reviewer
  owns that judgment; a wrong `covered` is still a review finding.

## Break-change

Before a product-cut PR, run `@break-change`. Targeted mode attacks the changed
entrypoints. Removal mode proves a deleted command or UI entrypoint is absent
from `/help`, the registry, the UI, docs, this map, imports, and routes. General
mode lists `partial` and `NONE` rows and targets a small high-risk subset.

A break-change report is a lead, not a proof. It does not upgrade a row. Promote a
confirmed finding into a committed user-action check, then update the table.
