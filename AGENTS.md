# AGENTS.md

This is the canonical agent guide for this repository — guidance for any coding agent working in this codebase (Claude Code reads it through the `CLAUDE.md` symlink).

## What this is

An Obsidian plugin (`id: agentic-chat`): an agent-led chat in the right sidebar that reads/searches/writes the vault through typed tools. The agent core is the **pi** stack — `@earendil-works/pi-agent-core` (the agent loop) and `@earendil-works/pi-ai` (model/streaming). The plugin does not implement the loop; it configures pi and supplies hooks.

## Commands

```bash
npm install
npm run dev          # esbuild watch → rebuilds main.js in place
npm run build        # tsc -noEmit + production bundle (what releases ship)
npm run typecheck    # tsc -noEmit — this is the lint gate; there is NO eslint
npm test             # vitest run (no Obsidian needed)
npm run test:watch   # vitest watch
```

- Single test file: `npx vitest run test/approval.test.ts`
- Single test by name: `npx vitest run -t "honors explicit per-tool overrides"`
- **Live tests** hit the real OpenRouter API and are excluded from `npm test`. Run with `scripts/run-live-tests.sh` (loads `OPENROUTER_API_KEY` from an `.env`; never commit the key). They live in `test/live/**` and use `vitest.live.config.ts`.

CI (`.github/workflows/ci.yml`) runs exactly: `typecheck`, `test`, `build` on **Node 22** (pi-\* require `>=22.19`). There is no separate lint job — keep `tsc` strict-clean.

## Architecture (the parts that span files)

**`main.ts` → `AgentService` → pi `Agent`.** `main.ts` registers the `ChatView`, settings tab, commands, and constructs the single `AgentService` (`src/agent/agent-service.ts`). `AgentService` is the hub: it wraps pi's `Agent` and feeds it everything — a `streamFn` (pi-ai `streamSimple` + request tuning + OpenRouter attribution headers), the model, vault tools, a `beforeToolCall` approval gate, and a JSONL session store. It fans pi events out to the UI via `onEvent`/`onChange`. To change agent behavior you almost always edit `AgentService`, not the UI.

**Approval gate — non-obvious contract.** `beforeToolCall` → `gateToolCall` → `resolvePolicy(settings.approval, toolName)` (`src/agent/approval.ts`): a `perTool` override wins; otherwise mutating tools (`MUTATING_TOOLS` in `src/tools/vault-tools.ts`) follow `approval.mutating`; read-only tools are always `allow`. Returning `{ block: true, reason }` from `gateToolCall` makes **pi** emit an `isError` tool result containing `reason` and feed it back to the model on the next turn — that is how a denial reaches the model (do not try to inject the denial message yourself). The "remember" checkbox in `ApprovalModal` persists a per-tool `"allow"` override via `main.ts` `confirmToolCall`.

**Model construction + privacy routing.** `src/llm/models.ts` `buildModel` branches OpenRouter vs Ollama. Privacy settings are baked into `model.compat.openRouterRouting` per request: `denyDataCollection → data_collection:"deny"`, `requireZDR → zdr:true`, `allowFallbacks`. Known models are hydrated from pi-ai's catalog (`getModels`); unknown ids get a synthesized model. `listOpenRouterModels` fetches the live catalog for the model browser (filtered to `supportsTools`).

**Sessions are append-only JSONL on the vault adapter** (`src/session/`), not SQLite/Node fs — so it works on mobile. `ObsidianSessionManager` writes under the plugin dir. Entries (`session` header, `model_change`, `thinking_level_change`, `session_info`, `message`) form a linked list via `parentId`/`leafId`; `buildSessionContext` reconstructs the message list. Each `AgentMessage` is persisted once (a `WeakSet` de-dupes) on pi's `message_end`/`agent_end` events. Tool-result messages are persisted too (pi emits `message_end` for them).

**UI rendering.** `ChatView` (`src/ui/chat-view.ts`) orchestrates the transcript and live pi events; the heavy lifting is split into units — `AssistantBubble` (`src/ui/assistant-bubble.ts`) owns the DOM of one assistant turn (reasoning `<details>`, tool step cards, streamed text, copy/retry actions, usage footer); pure message/format helpers live in `message-content.ts`/`format.ts`. Slash commands come from one registry (`src/ui/commands.ts`), parsed in `handleSlashCommand`; informational ones (`/help`, `/status`, `/usage`) render as a collapsible in-pane block via `renderInfoMessage` and are **never sent to the model**. The model picker (a flat list of hundreds of model ids) uses `SuggestModal` (not `FuzzySuggestModal`) so filtered results stay alphabetical. The composer's inline autocomplete (`src/ui/autocomplete.ts` engine + `autocomplete-menu.ts` widget — slash/skill/`@`-mention) is a **separate, deliberately non-modal** surface: a small dropdown over the textarea with prefix-rank + registry ordering (Copilot-style), so the `SuggestModal`/alphabetical rule does **not** apply to it.

**Skills & prompt templates** (`src/skills/skills.ts`) are loaded from vault folders set in settings: `SKILL.md` files (agentskills.io frontmatter) are listed to the model and run via `/skill`; templates support `$ARGUMENTS`/`$1` and run via `/template`.

## Testing model (so changes don't break the suite)

Tests run without Obsidian. `vitest.config.ts` aliases the `obsidian` import to `test/mocks/obsidian.ts`, a **minimal** mock that only defines what non-UI code touches. UI files (`chat-view`, `settings`, the modals) are not imported by tests directly — but if a test imports a module that *transitively* imports a UI file, the mock must define every base class that file `extends`, or the suite fails at class-definition time (e.g. adding `SuggestModal` to the mock was required when a modal switched to it). The model stream is replaced by an injected `streamFn` (see `cannedStreamFn`/`scriptedStreamFn` in `test/agent-service.test.ts`); the session store by an in-memory `MemoryAdapter`.

## Releases & commits

Releases are automated by **semantic-release** on `main`, so commit messages must be **Conventional Commits** (`fix:` → patch, `feat:` → minor; the type drives the version). Do not hand-edit versions: `scripts/version-bump.mjs` syncs `manifest.json` + `versions.json`, and the release commit is `chore(release): x.y.z [skip ci]`. Build artifacts (`main.js`, `manifest.json`, `styles.css`) are attached to the GitHub release. Work on a branch and open a PR; pushing to `main` triggers the release workflow.

The esbuild bundle externalizes provider SDKs that pi-ai registers lazily but this plugin never uses (Anthropic/AWS/Google/Mistral, proxies, `canvas`) — only the OpenRouter `openai-completions` path runs. If you add a real dependency on one, remove it from the `external` list in `esbuild.config.mjs`.
