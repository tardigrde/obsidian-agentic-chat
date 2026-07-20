# SonarCloud Issues Report

**Project:** tardigrde/obsidian-agentic-chat (`tardigrde_obsidian-agentic-chat`)
**Branch:** main
**Total open issues:** 320
**Generated:** 2026-07-19

---

## VULNERABILITY (Security) — 1 issues

### MAJOR

| File | Line | Rule | Message |
|------|------|------|---------|
| scripts/install-android-plugin.mjs | 38 | jssecurity:S8705 | LLMs running this code with faulty CLI arguments can escape from shell sandboxes. Refactor this code to validate untrusted data before passing them to OS commands. |

---

## BUG (Reliability) — 0 issues

---

## CODE_SMELL (Maintainability) — 319 issues

### CRITICAL

| File | Line | Rule | Message |
|------|------|------|---------|
| src/agent/plan-tracker.ts | 177 | typescript:S3776 | Refactor this function to reduce its Cognitive Complexity from 19 to the 15 allowed. |
| src/agent/undo.ts | 44 | typescript:S3776 | Refactor this function to reduce its Cognitive Complexity from 22 to the 15 allowed. |
| src/ui/format.ts | 88 | typescript:S3776 | Refactor this function to reduce its Cognitive Complexity from 27 to the 15 allowed. |
| scripts/agentic-eval-core.ts | 486 | typescript:S3776 | Refactor this function to reduce its Cognitive Complexity from 19 to the 15 allowed. |
| scripts/agentic-eval-judge.ts | 358 | typescript:S3776 | Refactor this function to reduce its Cognitive Complexity from 23 to the 15 allowed. |
| scripts/analyze-session-trace.mjs | 114 | javascript:S3776 | Refactor this function to reduce its Cognitive Complexity from 18 to the 15 allowed. |
| scripts/analyze-session-trace.mjs | 176 | javascript:S3776 | Refactor this function to reduce its Cognitive Complexity from 46 to the 15 allowed. |
| scripts/dogfood-core.ts | 188 | typescript:S3776 | Refactor this function to reduce its Cognitive Complexity from 135 to the 15 allowed. |
| scripts/run-agentic-evals.ts | 483 | typescript:S3776 | Refactor this function to reduce its Cognitive Complexity from 18 to the 15 allowed. |
| scripts/verify-provider-live.mjs | 42 | javascript:S3776 | Refactor this function to reduce its Cognitive Complexity from 20 to the 15 allowed. |
| src/retrieval/document-ingest.ts | 264 | typescript:S3776 | Refactor this function to reduce its Cognitive Complexity from 17 to the 15 allowed. |
| src/retrieval/document-ingest.ts | 304 | typescript:S3776 | Refactor this function to reduce its Cognitive Complexity from 21 to the 15 allowed. |
| src/retrieval/pdf-ingest.ts | 221 | typescript:S3776 | Refactor this function to reduce its Cognitive Complexity from 24 to the 15 allowed. |
| src/retrieval/pdf-ingest.ts | 263 | typescript:S3776 | Refactor this function to reduce its Cognitive Complexity from 17 to the 15 allowed. |
| src/tools/external-workspace.ts | 381 | typescript:S3776 | Refactor this function to reduce its Cognitive Complexity from 20 to the 15 allowed. |
| src/tools/external-workspace.ts | 542 | typescript:S3776 | Refactor this function to reduce its Cognitive Complexity from 29 to the 15 allowed. |
| test/e2e/dogfood/live-workspace.dogfood.ts | 461 | typescript:S3776 | Refactor this function to reduce its Cognitive Complexity from 17 to the 15 allowed. |
| test/e2e/dogfood/stretch-synthetic.dogfood.ts | 295 | typescript:S3776 | Refactor this function to reduce its Cognitive Complexity from 18 to the 15 allowed. |
| scripts/dogfood.ts | 226 | typescript:S3776 | Refactor this function to reduce its Cognitive Complexity from 16 to the 15 allowed. |
| scripts/verify-mobile-compat.mjs | 98 | javascript:S3776 | Refactor this function to reduce its Cognitive Complexity from 19 to the 15 allowed. |
| src/mcp/client.ts | 193 | typescript:S3776 | Refactor this function to reduce its Cognitive Complexity from 25 to the 15 allowed. |
| src/mcp/oauth.ts | 343 | typescript:S3776 | Refactor this function to reduce its Cognitive Complexity from 30 to the 15 allowed. |
| src/settings.ts | 343 | typescript:S2004 | Refactor this code to not nest functions more than 4 levels deep. |
| src/settings.ts | 677 | typescript:S2004 | Refactor this code to not nest functions more than 4 levels deep. |
| src/session/export.ts | 17 | typescript:S3776 | Refactor this function to reduce its Cognitive Complexity from 33 to the 15 allowed. |
| src/tools/web-fetch.ts | 368 | typescript:S3776 | Refactor this function to reduce its Cognitive Complexity from 19 to the 15 allowed. |

### MAJOR

| File | Line | Rule | Message |
|------|------|------|---------|
| scripts/agentic-eval-judge.ts | 344 | typescript:S8786 | Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking. |
| scripts/agentic-eval-judge.ts | 350 | typescript:S8786 | Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking. |
| scripts/agentic-eval-judge.ts | 464 | typescript:S8786 | Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking. |
| scripts/agentic-eval-judge.ts | 471 | typescript:S8786 | Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking. |
| scripts/dogfood-core.ts | 441 | typescript:S4624 | Refactor this code to not use nested template literals. |
| scripts/dogfood-core.ts | 535 | typescript:S8786 | Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking. |
| scripts/dogfood-core.ts | 589 | typescript:S4624 | Refactor this code to not use nested template literals. |
| scripts/dogfood-core.ts | 592 | typescript:S4624 | Refactor this code to not use nested template literals. |
| scripts/eval-provider-cache-live.mjs | 53 | javascript:S8786 | Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking. |
| scripts/eval-provider-cache-live.mjs | 57 | javascript:S8786 | Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking. |
| scripts/eval-provider-cache-live.mjs | 61 | javascript:S8786 | Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking. |
| scripts/eval-provider-cache-live.mjs | 145 | javascript:S8786 | Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking. |
| scripts/eval-provider-cache-live.mjs | 325 | javascript:S7785 | Prefer top-level await over using a promise chain. |
| scripts/live-env.mjs | 18 | javascript:S8786 | Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking. |
| scripts/live-env.mjs | 62 | javascript:S8786 | Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking. |
| scripts/run-agentic-evals.ts | 567 | typescript:S8786 | Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking. |
| src/agent/compaction-runtime.ts | 302 | typescript:S107 | Async function 'generateSummaryWithStream' has too many parameters (10). Maximum allowed is 7. |
| src/agent/plan-tracker.ts | 163 | typescript:S4624 | Refactor this code to not use nested template literals. |
| src/agent/tool-call-controller.ts | 60 | typescript:S2933 | Mark this member as `readonly`. |
| src/llm/models.ts | 324 | typescript:S8786 | Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking. |
| src/mcp/settings.ts | 373 | typescript:S3358 | Extract this nested ternary operation into an independent statement. |
| src/memory/extraction.ts | 192 | typescript:S8786 | Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking. |
| src/memory/extraction.ts | 193 | typescript:S8786 | Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking. |
| src/memory/extraction.ts | 211 | typescript:S8786 | Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking. |
| src/memory/extraction.ts | 212 | typescript:S8786 | Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking. |
| src/memory/extraction.ts | 213 | typescript:S8786 | Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking. |
| src/memory/management.ts | 58 | typescript:S4043 | Move this array "sort" operation to a separate statement or replace it with "toSorted". |
| src/memory/management.ts | 115 | typescript:S3358 | Extract this nested ternary operation into an independent statement. |
| src/memory/management.ts | 130 | typescript:S4624 | Refactor this code to not use nested template literals. |
| src/memory/management.ts | 136 | typescript:S4624 | Refactor this code to not use nested template literals. |
| src/observability/agent-observability.ts | 32 | typescript:S4782 | Consider removing 'undefined' type or '?' specifier, one of them is redundant. |
| src/observability/otlp.ts | 85 | typescript:S4624 | Refactor this code to not use nested template literals. |
| src/observability/settings.ts | 125 | typescript:S8786 | Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking. |
| src/privacy/redaction.ts | 11 | typescript:S5869 | Remove duplicates in this character class. |
| src/privacy/redaction.ts | 12 | typescript:S5869 | Remove duplicates in this character class. |
| src/privacy/redaction.ts | 15 | typescript:S5843 | Simplify this regular expression to reduce its complexity from 35 to the 20 allowed. |
| src/privacy/redaction.ts | 41 | typescript:S5843 | Simplify this regular expression to reduce its complexity from 22 to the 20 allowed. |
| src/projects/projects.ts | 110 | typescript:S3358 | Extract this nested ternary operation into an independent statement. |
| src/projects/projects.ts | 111 | typescript:S3358 | Extract this nested ternary operation into an independent statement. |
| src/projects/projects.ts | 175 | typescript:S8786 | Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking. |
| src/retrieval/citations.ts | 179 | typescript:S8786 | Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking. |
| src/retrieval/embeddings.ts | 144 | typescript:S3358 | Extract this nested ternary operation into an independent statement. |
| src/retrieval/embeddings.ts | 150 | typescript:S3358 | Extract this nested ternary operation into an independent statement. |
| src/retrieval/embeddings.ts | 450 | typescript:S3358 | Extract this nested ternary operation into an independent statement. |
| src/retrieval/embeddings.ts | 456 | typescript:S8786 | Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking. |
| src/retrieval/pdf-ingest.ts | 228 | typescript:S2310 | Remove this assignment of "index". |
| src/retrieval/relevant-notes.ts | 254 | typescript:S8786 | Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking. |
| src/retrieval/relevant-notes.ts | 291 | typescript:S8786 | Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking. |
| src/retrieval/relevant-notes.ts | 329 | typescript:S8786 | Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking. |
| src/retrieval/relevant-notes.ts | 344 | typescript:S8786 | Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking. |
| src/retrieval/semantic-index.ts | 192 | typescript:S8786 | Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking. |
| src/retrieval/semantic.ts | 42 | typescript:S4043 | Move this array "sort" operation to a separate statement or replace it with "toSorted". |
| src/retrieval/source-artifacts.ts | 67 | typescript:S5843 | Simplify this regular expression to reduce its complexity from 42 to the 20 allowed. |
| src/retrieval/source-artifacts.ts | 70 | typescript:S5843 | Simplify this regular expression to reduce its complexity from 22 to the 20 allowed. |
| src/retrieval/source-artifacts.ts | 340 | typescript:S8786 | Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking. |
| src/retrieval/source-artifacts.ts | 346 | typescript:S8786 | Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking. |
| src/retrieval/source-artifacts.ts | 370 | typescript:S6557 | Use 'String#startsWith' method instead. |
| src/settings-mcp-state.ts | 26 | typescript:S3358 | Extract this nested ternary operation into an independent statement. |
| src/tools/external-workspace.ts | 407 | typescript:S3358 | Extract this nested ternary operation into an independent statement. |
| src/tools/external-workspace.ts | 415 | typescript:S3358 | Extract this nested ternary operation into an independent statement. |
| src/tools/external-workspace.ts | 595 | typescript:S3358 | Extract this nested ternary operation into an independent statement. |
| src/tools/external-workspace.ts | 887 | typescript:S8786 | Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking. |
| src/tools/web-fetch.ts | 175 | typescript:S3358 | Extract this nested ternary operation into an independent statement. |
| src/tools/web-fetch.ts | 243 | typescript:S3358 | Extract this nested ternary operation into an independent statement. |
| src/tools/web-fetch.ts | 323 | typescript:S8786 | Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking. |
| src/tools/web-fetch.ts | 326 | typescript:S8786 | Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking. |
| src/ui/approval-modal.ts | 224 | typescript:S3358 | Extract this nested ternary operation into an independent statement. |
| src/ui/assistant-bubble.ts | 409 | typescript:S7761 | Prefer `.dataset` over `getAttribute(…)`. |
| src/ui/chat-view.ts | 1158 | typescript:S3358 | Extract this nested ternary operation into an independent statement. |
| src/ui/chat-view.ts | 1653 | typescript:S4624 | Refactor this code to not use nested template literals. |
| src/ui/chat-view.ts | 1661 | typescript:S4624 | Refactor this code to not use nested template literals. |
| src/ui/chat-view.ts | 1670 | typescript:S4624 | Refactor this code to not use nested template literals. |
| src/ui/chat-view.ts | 1836 | typescript:S4624 | Refactor this code to not use nested template literals. |
| src/ui/chrome-state.ts | 84 | typescript:S3358 | Extract this nested ternary operation into an independent statement. |
| src/ui/commands.ts | 81 | typescript:S8786 | Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking. |
| src/ui/composer-input.ts | 9 | typescript:S8786 | Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking. |
| src/ui/context-chip-renderer.ts | 52 | typescript:S3358 | Extract this nested ternary operation into an independent statement. |
| src/ui/context-chip-renderer.ts | 52 | typescript:S3358 | Extract this nested ternary operation into an independent statement. |
| src/ui/memory-workflow-controller.ts | 272 | typescript:S8786 | Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking. |
| src/ui/quick-ask-modal.ts | 26 | typescript:S3358 | Extract this nested ternary operation into an independent statement. |
| src/ui/quick-ask-modal.ts | 27 | typescript:S3358 | Extract this nested ternary operation into an independent statement. |
| src/ui/quick-ask-modal.ts | 97 | typescript:S3358 | Extract this nested ternary operation into an independent statement. |
| src/ui/quick-ask.ts | 84 | typescript:S8786 | Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking. |
| src/ui/quick-ask.ts | 89 | typescript:S8786 | Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking. |
| src/ui/quick-ask.ts | 96 | typescript:S8786 | Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking. |
| styles.css | 1518 | css:S4666 | Duplicate selector ".agentic-chat-plan-badge", first used at line 973 |
| styles.css | 1646 | css:S4666 | Duplicate selector ".agentic-chat-diff-line", first used at line 479 |
| styles.css | 1653 | css:S4666 | Duplicate selector ".agentic-chat-diff-line.is-add", first used at line 490 |
| test/e2e/dogfood/live-workspace.dogfood.ts | 84 | typescript:S8786 | Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking. |
| test/e2e/dogfood/stretch-synthetic.dogfood.ts | 209 | typescript:S4624 | Refactor this code to not use nested template literals. |
| scripts/dogfood.ts | 209 | typescript:S2933 | Mark this member as `readonly`. |
| scripts/install-android-plugin.mjs | 27 | javascript:S8786 | Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking. |
| scripts/verify-mobile-compat.mjs | 101 | javascript:S8786 | Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking. |
| scripts/verify-mobile-compat.mjs | 108 | javascript:S8786 | Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking. |
| src/agent/e2e-stream.ts | 18 | typescript:S4782 | Consider removing 'undefined' type or '?' specifier, one of them is redundant. |
| src/llm/models.ts | 147 | typescript:S8786 | Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking. |
| src/llm/openai-compatible-request.ts | 513 | typescript:S4624 | Refactor this code to not use nested template literals. |
| src/mcp/fetcher.ts | 179 | typescript:S4624 | Refactor this code to not use nested template literals. |
| src/mcp/fetcher.ts | 251 | typescript:S4144 | Update this function so that its implementation is not identical to the one on line 149. |
| src/mcp/fetcher.ts | 367 | typescript:S4624 | Refactor this code to not use nested template literals. |
| src/mcp/oauth.ts | 751 | typescript:S8786 | Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking. |
| src/mcp/oauth.ts | 1085 | typescript:S3358 | Extract this nested ternary operation into an independent statement. |
| src/mcp/settings.ts | 420 | typescript:S8786 | Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking. |
| src/mcp/tools.ts | 239 | typescript:S4624 | Refactor this code to not use nested template literals. |
| src/mcp/tools.ts | 266 | typescript:S3358 | Extract this nested ternary operation into an independent statement. |
| src/mcp/tools.ts | 381 | typescript:S8786 | Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking. |
| src/secrets/secret-store.ts | 91 | typescript:S8786 | Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking. |
| src/settings.ts | 175 | typescript:S8786 | Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking. |
| src/settings.ts | 176 | typescript:S8786 | Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking. |
| src/settings.ts | 1323 | typescript:S3358 | Extract this nested ternary operation into an independent statement. |
| src/settings.ts | 1323 | typescript:S4624 | Refactor this code to not use nested template literals. |
| src/ui/assistant-bubble.ts | 493 | typescript:S8786 | Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking. |
| src/ui/attachment-ref.ts | 15 | typescript:S3358 | Extract this nested ternary operation into an independent statement. |
| src/ui/attachment-ref.ts | 25 | typescript:S6557 | Use 'String#startsWith' method instead. |
| src/ui/autocomplete.ts | 203 | typescript:S3358 | Extract this nested ternary operation into an independent statement. |
| src/ui/note-slices.ts | 60 | typescript:S8786 | Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking. |
| src/ui/note-slices.ts | 62 | typescript:S8786 | Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking. |
| test/e2e/support/failure-artifacts.ts | 178 | typescript:S8786 | Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking. |
| test/e2e/support/settings-ui.ts | 87 | typescript:S4144 | Update this function so that its implementation is not identical to the one on line 68. |
| test/e2e/support/settings-ui.ts | 110 | typescript:S4144 | Update this function so that its implementation is not identical to the one on line 68. |
| test/e2e/support/settings-ui.ts | 130 | typescript:S4144 | Update this function so that its implementation is not identical to the one on line 68. |
| test/e2e/support/settings-ui.ts | 142 | typescript:S3358 | Extract this nested ternary operation into an independent statement. |
| test/e2e/support/settings-ui.ts | 146 | typescript:S3358 | Extract this nested ternary operation into an independent statement. |
| test/e2e/support/settings-ui.ts | 146 | typescript:S3358 | Extract this nested ternary operation into an independent statement. |
| test/e2e/support/settings-ui.ts | 166 | typescript:S4144 | Update this function so that its implementation is not identical to the one on line 68. |
| wdio.conf.mts | 53 | typescript:S8786 | Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking. |
| wdio.conf.mts | 56 | typescript:S8786 | Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking. |
| src/ui/chat-view.ts | 1473 | typescript:S4624 | Refactor this code to not use nested template literals. |
| src/tools/web-search.ts | 93 | typescript:S8786 | Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking. |
| src/ui/approval-modal.ts | 201 | typescript:S3358 | Extract this nested ternary operation into an independent statement. |
| src/llm/models.ts | 225 | typescript:S4624 | Refactor this code to not use nested template literals. |
| src/session/session-manager.ts | 495 | typescript:S8786 | Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking. |
| src/ui/autocomplete.ts | 140 | typescript:S4624 | Refactor this code to not use nested template literals. |
| src/ui/chat-view.ts | 2118 | typescript:S4624 | Refactor this code to not use nested template literals. |
| test/mocks/obsidian.ts | 102 | typescript:S8786 | Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking. |

### MINOR

| File | Line | Rule | Message |
|------|------|------|---------|
| src/agent/modes.ts | 115 | typescript:S6653 | Use 'Object.hasOwn()' instead of 'Object.prototype.hasOwnProperty.call()'. |
| src/agent/replay-stream.ts | 270 | typescript:S7784 | Prefer `structuredClone(…)` over `JSON.parse(JSON.stringify(…))` to create a deep clone. |
| src/secrets/secret-store.ts | 227 | typescript:S7784 | Prefer `structuredClone(…)` over `JSON.parse(JSON.stringify(…))` to create a deep clone. |
| scripts/analyze-session-trace.mjs | 690 | javascript:S7781 | Prefer `String#replaceAll()` over `String#replace()`. |
| scripts/compare-agentic-evals.ts | 429 | typescript:S7781 | Prefer `String#replaceAll()` over `String#replace()`. |
| scripts/compare-agentic-evals.ts | 430 | typescript:S7781 | Prefer `String#replaceAll()` over `String#replace()`. |
| scripts/compare-agentic-evals.ts | 430 | typescript:S7780 | `String.raw` should be used to avoid escaping `\`. |
| src/agent/runtime-resources.ts | 121 | typescript:S7778 | Do not call `Array#push()` multiple times. |
| src/tools/read-skill-tool.ts | 1 | typescript:S3863 | '@earendil-works/pi-agent-core' imported multiple times. |
| src/tools/read-skill-tool.ts | 4 | typescript:S3863 | '@earendil-works/pi-agent-core' imported multiple times. |
| src/agent/undo.ts | 28 | typescript:S7758 | Prefer `String#codePointAt()` over `String#charCodeAt()`. |
| src/ui/assistant-bubble.ts | 350 | typescript:S6582 | Prefer using an optional chain expression instead, as it's more concise and easier to read. |
| src/vault/edit.ts | 46 | typescript:S7765 | Use `.includes()`, rather than `.indexOf()`, when checking for existence. |
| src/vault/edit.ts | 215 | typescript:S7780 | `String.raw` should be used to avoid escaping `\`. |
| scripts/agentic-eval-core.ts | 676 | typescript:S7780 | `String.raw` should be used to avoid escaping `\`. |
| scripts/agentic-eval-judge.ts | 187 | typescript:S7744 | The empty object is useless. |
| scripts/agentic-eval-judge.ts | 417 | typescript:S6353 | Use concise character class syntax '\w' instead of '[A-Za-z0-9_]'. |
| scripts/agentic-eval-judge.ts | 471 | typescript:S6594 | Use the "RegExp.exec()" method instead. |
| scripts/analyze-session-trace.mjs | 556 | javascript:S7758 | Prefer `String#codePointAt()` over `String#charCodeAt()`. |
| scripts/analyze-session-trace.mjs | 691 | javascript:S7781 | Prefer `String#replaceAll()` over `String#replace()`. |
| scripts/analyze-session-trace.mjs | 691 | javascript:S7780 | `String.raw` should be used to avoid escaping `\`. |
| scripts/compare-agentic-evals.ts | 6 | typescript:S6571 | "pass" is overridden by string in this union type. |
| scripts/compare-agentic-evals.ts | 6 | typescript:S6571 | "problem" is overridden by string in this union type. |
| scripts/compare-agentic-evals.ts | 6 | typescript:S6571 | "skipped" is overridden by string in this union type. |
| scripts/compare-agentic-evals.ts | 7 | typescript:S6571 | "error" is overridden by string in this union type. |
| scripts/compare-agentic-evals.ts | 7 | typescript:S6571 | "warning" is overridden by string in this union type. |
| scripts/dogfood-core.ts | 552 | typescript:S7781 | Prefer `String#replaceAll()` over `String#replace()`. |
| scripts/live-env.mjs | 18 | javascript:S6353 | Use concise character class syntax '\w' instead of '[A-Za-z0-9_]'. |
| scripts/run-agentic-evals.ts | 140 | typescript:S7744 | The empty object is useless. |
| scripts/run-agentic-evals.ts | 271 | typescript:S7744 | The empty object is useless. |
| src/agent/action-audit-log.ts | 381 | typescript:S7781 | Prefer `String#replaceAll()` over `String#replace()`. |
| src/agent/command-invocation.ts | 1 | typescript:S3863 | './command-dispatcher' imported multiple times. |
| src/agent/command-invocation.ts | 8 | typescript:S3863 | './command-dispatcher' imported multiple times. |
| src/agent/runtime-resources.ts | 109 | typescript:S7778 | Do not call `Array#push()` multiple times. |
| src/memory/extraction.ts | 261 | typescript:S7758 | Prefer `String#codePointAt()` over `String#charCodeAt()`. |
| src/memory/memory.ts | 135 | typescript:S7778 | Do not call `Array#push()` multiple times. |
| src/observability/agent-observability.ts | 447 | typescript:S7758 | Prefer `String#codePointAt()` over `String#charCodeAt()`. |
| src/observability/otlp.ts | 158 | typescript:S7786 | `new Error()` is too unspecific for a type check. Use `new TypeError()` instead. |
| src/observability/otlp.ts | 162 | typescript:S7758 | Prefer `String.fromCodePoint()` over `String.fromCharCode()`. |
| src/observability/settings.ts | 58 | typescript:S7776 | `OBSERVABILITY_BACKENDS` should be a `Set`, and use `OBSERVABILITY_BACKENDS.has()` to check existence or non-existence. |
| src/observability/settings.ts | 59 | typescript:S7776 | `OBSERVABILITY_PAYLOAD_MODES` should be a `Set`, and use `OBSERVABILITY_PAYLOAD_MODES.has()` to check existence or non-existence. |
| src/observability/settings.ts | 66 | typescript:S7744 | The empty object is useless. |
| src/retrieval/citations.ts | 169 | typescript:S7781 | Prefer `String#replaceAll()` over `String#replace()`. |
| src/retrieval/citations.ts | 220 | typescript:S7780 | `String.raw` should be used to avoid escaping `\`. |
| src/retrieval/citations.ts | 220 | typescript:S7781 | Prefer `String#replaceAll()` over `String#replace()`. |
| src/retrieval/citations.ts | 220 | typescript:S7781 | Prefer `String#replaceAll()` over `String#replace()`. |
| src/retrieval/citations.ts | 220 | typescript:S7780 | `String.raw` should be used to avoid escaping `\`. |
| src/retrieval/citations.ts | 220 | typescript:S7781 | Prefer `String#replaceAll()` over `String#replace()`. |
| src/retrieval/diagnostics.ts | 154 | typescript:S7781 | Prefer `String#replaceAll()` over `String#replace()`. |
| src/retrieval/document-ingest.ts | 373 | typescript:S7786 | `new Error()` is too unspecific for a type check. Use `new TypeError()` instead. |
| src/retrieval/document-ingest.ts | 468 | typescript:S7758 | Prefer `String#codePointAt()` over `String#charCodeAt()`. |
| src/retrieval/embeddings.ts | 450 | typescript:S7773 | Prefer `Number.NaN` over `NaN`. |
| src/retrieval/evidence-ledger.ts | 161 | typescript:S7754 | Prefer `.some(…)` over `.find(…)`. |
| src/retrieval/lexical.ts | 217 | typescript:S7781 | Prefer `String#replaceAll()` over `String#replace()`. |
| src/retrieval/pdf-ingest.ts | 284 | typescript:S7758 | Prefer `String.fromCodePoint()` over `String.fromCharCode()`. |
| src/retrieval/pdf-ingest.ts | 310 | typescript:S7758 | Prefer `String.fromCodePoint()` over `String.fromCharCode()`. |
| src/retrieval/pdf-ingest.ts | 331 | typescript:S7758 | Prefer `String.fromCodePoint()` over `String.fromCharCode()`. |
| src/retrieval/relevant-notes.ts | 361 | typescript:S7781 | Prefer `String#replaceAll()` over `String#replace()`. |
| src/retrieval/relevant-notes.ts | 370 | typescript:S7781 | Prefer `String#replaceAll()` over `String#replace()`. |
| src/retrieval/semantic.ts | 21 | typescript:S6582 | Prefer using an optional chain expression instead, as it's more concise and easier to read. |
| src/retrieval/source-artifacts.ts | 307 | typescript:S7780 | `String.raw` should be used to avoid escaping `\`. |
| src/retrieval/source-artifacts.ts | 314 | typescript:S7780 | `String.raw` should be used to avoid escaping `\`. |
| src/retrieval/source-hash.ts | 13 | typescript:S7758 | Prefer `String#codePointAt()` over `String#charCodeAt()`. |
| src/settings-schema.ts | 237 | typescript:S7744 | The empty object is useless. |
| src/settings-schema.ts | 240 | typescript:S7744 | The empty object is useless. |
| src/settings-schema.ts | 241 | typescript:S7744 | The empty object is useless. |
| src/settings-schema.ts | 248 | typescript:S7744 | The empty object is useless. |
| src/settings-schema.ts | 249 | typescript:S7744 | The empty object is useless. |
| src/settings-schema.ts | 254 | typescript:S7744 | The empty object is useless. |
| src/tools/external-workspace.ts | 218 | typescript:S7744 | The empty object is useless. |
| src/tools/external-workspace.ts | 799 | typescript:S7781 | Prefer `String#replaceAll()` over `String#replace()`. |
| src/tools/external-workspace.ts | 803 | typescript:S7781 | Prefer `String#replaceAll()` over `String#replace()`. |
| src/tools/external-workspace.ts | 893 | typescript:S7758 | Prefer `String#codePointAt()` over `String#charCodeAt()`. |
| src/tools/vault-tools.ts | 518 | typescript:S6582 | Prefer using an optional chain expression instead, as it's more concise and easier to read. |
| src/ui/active-note.ts | 132 | typescript:S6582 | Prefer using an optional chain expression instead, as it's more concise and easier to read. |
| src/ui/active-note.ts | 139 | typescript:S7758 | Prefer `String#codePointAt()` over `String#charCodeAt()`. |
| src/ui/assistant-bubble.ts | 467 | typescript:S6644 | Unnecessary use of conditional expression for default assignment. |
| src/ui/chat-view.ts | 1554 | typescript:S7747 | Unnecessarily cloning an array. |
| src/ui/info-panel-renderer.ts | 19 | typescript:S6594 | Use the "RegExp.exec()" method instead. |
| src/ui/memory-workflow-controller.ts | 230 | typescript:S7781 | Prefer `String#replaceAll()` over `String#replace()`. |
| src/ui/memory-workflow-controller.ts | 284 | typescript:S7758 | Prefer `String#codePointAt()` over `String#charCodeAt()`. |
| src/ui/relevant-notes-renderer.ts | 92 | typescript:S7750 | Prefer `.findLast(…)` over `.filter(…).pop()`. |
| src/ui/semantic-index-workflow-controller.ts | 183 | typescript:S7778 | Do not call `Array#push()` multiple times. |
| src/ui/semantic-index-workflow-controller.ts | 184 | typescript:S7778 | Do not call `Array#push()` multiple times. |
| src/ui/working-directory-workflow-controller.ts | 293 | typescript:S7781 | Prefer `String#replaceAll()` over `String#replace()`. |
| src/ui/working-directory-workflow-controller.ts | 307 | typescript:S7781 | Prefer `String#replaceAll()` over `String#replace()`. |
| src/ui/working-directory-workflow-controller.ts | 333 | typescript:S7781 | Prefer `String#replaceAll()` over `String#replace()`. |
| test/e2e/dogfood/live-workspace.dogfood.ts | 520 | typescript:S7780 | `String.raw` should be used to avoid escaping `\`. |
| test/e2e/dogfood/live-workspace.dogfood.ts | 521 | typescript:S7780 | `String.raw` should be used to avoid escaping `\`. |
| test/e2e/dogfood/live-workspace.dogfood.ts | 522 | typescript:S7780 | `String.raw` should be used to avoid escaping `\`. |
| test/e2e/dogfood/live-workspace.dogfood.ts | 529 | typescript:S7780 | `String.raw` should be used to avoid escaping `\`. |
| test/e2e/dogfood/live-workspace.dogfood.ts | 530 | typescript:S7780 | `String.raw` should be used to avoid escaping `\`. |
| test/e2e/dogfood/live-workspace.dogfood.ts | 531 | typescript:S7780 | `String.raw` should be used to avoid escaping `\`. |
| test/e2e/dogfood/live-workspace.dogfood.ts | 536 | typescript:S7780 | `String.raw` should be used to avoid escaping `\`. |
| test/helpers/agent-replay.ts | 38 | typescript:S7744 | The empty object is useless. |
| test/helpers/retrieval-fixtures.ts | 95 | typescript:S7758 | Prefer `String#codePointAt()` over `String#charCodeAt()`. |
| wdio.dogfood.conf.mts | 1 | typescript:S7772 | Prefer `node:process` over `process`. |
| src/ui/assistant-bubble.ts | 571 | typescript:S6582 | Prefer using an optional chain expression instead, as it's more concise and easier to read. |
| scripts/check-remote-mcp.ts | 92 | typescript:S6551 | 'value' may use Object's default stringification format ('[object Object]') when stringified. |
| scripts/check-remote-mcp.ts | 179 | typescript:S6551 | 'record.code ?? "unknown"' will use Object's default stringification format ('[object Object]') when stringified. |
| src/agent/command-dispatcher.ts | 31 | typescript:S7754 | Prefer `.some(…)` over `.find(…)`. |
| src/agent/diagnostics.ts | 204 | typescript:S7778 | Do not call `Array#push()` multiple times. |
| src/agent/diagnostics.ts | 205 | typescript:S7778 | Do not call `Array#push()` multiple times. |
| src/agent/runtime-resources.ts | 119 | typescript:S7778 | Do not call `Array#push()` multiple times. |
| src/agent/runtime-resources.ts | 120 | typescript:S7778 | Do not call `Array#push()` multiple times. |
| src/agent/stream-runtime.ts | 51 | typescript:S7744 | The empty object is useless. |
| src/artifacts/tool-artifact-tools.ts | 248 | typescript:S7758 | Prefer `String#codePointAt()` over `String#charCodeAt()`. |
| src/llm/openai-compatible-request.ts | 42 | typescript:S7744 | The empty object is useless. |
| src/llm/openai-compatible-request.ts | 121 | typescript:S7744 | The empty object is useless. |
| src/llm/openai-compatible-request.ts | 122 | typescript:S7744 | The empty object is useless. |
| src/mcp/oauth.ts | 750 | typescript:S7758 | Prefer `String.fromCodePoint()` over `String.fromCharCode()`. |
| src/mcp/oauth.ts | 751 | typescript:S7781 | Prefer `String#replaceAll()` over `String#replace()`. |
| src/mcp/oauth.ts | 751 | typescript:S7781 | Prefer `String#replaceAll()` over `String#replace()`. |
| src/mcp/oauth.ts | 929 | typescript:S7786 | `new Error()` is too unspecific for a type check. Use `new TypeError()` instead. |
| src/ui/assistant-bubble.ts | 289 | typescript:S6606 | Prefer using nullish coalescing operator (`??=`) instead of an assignment expression, as it is simpler to read. |
| src/ui/context-attachments.ts | 61 | typescript:S7758 | Prefer `String#codePointAt()` over `String#charCodeAt()`. |
| src/ui/note-slices.ts | 78 | typescript:S7780 | `String.raw` should be used to avoid escaping `\`. |
| src/ui/note-slices.ts | 79 | typescript:S7780 | `String.raw` should be used to avoid escaping `\`. |
| test/e2e/support/settings-ui.ts | 207 | typescript:S7784 | Prefer `structuredClone(…)` over `JSON.parse(JSON.stringify(…))` to create a deep clone. |
| test/helpers/agent-replay.ts | 36 | typescript:S7744 | The empty object is useless. |
| test/helpers/agent-replay.ts | 37 | typescript:S7744 | The empty object is useless. |
| wdio.conf.mts | 73 | typescript:S7786 | `new Error()` is too unspecific for a type check. Use `new TypeError()` instead. |
| wdio.conf.mts | 1 | typescript:S7772 | Prefer `node:path` over `path`. |
| wdio.conf.mts | 3 | typescript:S7772 | Prefer `node:process` over `process`. |
| src/session/export.ts | 55 | typescript:S7781 | Prefer `String#replaceAll()` over `String#replace()`. |
| src/session/export.ts | 67 | typescript:S7781 | Prefer `String#replaceAll()` over `String#replace()`. |
| src/session/export.ts | 68 | typescript:S7781 | Prefer `String#replaceAll()` over `String#replace()`. |
| src/session/export.ts | 68 | typescript:S7780 | `String.raw` should be used to avoid escaping `\`. |
| src/session/export.ts | 69 | typescript:S7781 | Prefer `String#replaceAll()` over `String#replace()`. |
| src/session/export.ts | 69 | typescript:S7780 | `String.raw` should be used to avoid escaping `\`. |
| src/session/export.ts | 70 | typescript:S7781 | Prefer `String#replaceAll()` over `String#replace()`. |
| src/session/export.ts | 70 | typescript:S7780 | `String.raw` should be used to avoid escaping `\`. |
| src/session/export.ts | 71 | typescript:S7781 | Prefer `String#replaceAll()` over `String#replace()`. |
| src/session/export.ts | 71 | typescript:S7780 | `String.raw` should be used to avoid escaping `\`. |
| src/ui/image-attachments.ts | 42 | typescript:S7758 | Prefer `String.fromCodePoint()` over `String.fromCharCode()`. |
| test/agent-service.test.ts | 358 | typescript:S5906 | Prefer "expect(files).toHaveLength(2)" over this generic assertion for better reporting; it works on any object with a numeric length property. |
| src/ui/active-note.ts | 121 | typescript:S6582 | Prefer using an optional chain expression instead, as it's more concise and easier to read. |
| src/agent/subagents.ts | 175 | typescript:S6582 | Prefer using an optional chain expression instead, as it's more concise and easier to read. |
| src/ui/assistant-bubble.ts | 276 | typescript:S6606 | Prefer using nullish coalescing operator (`??=`) instead of an assignment expression, as it is simpler to read. |
| src/session/session-manager.ts | 285 | typescript:S6582 | Prefer using an optional chain expression instead, as it's more concise and easier to read. |
| src/ui/chat-view.ts | 2649 | typescript:S6606 | Prefer using nullish coalescing operator (`??=`) instead of an assignment expression, as it is simpler to read. |
| src/llm/models.ts | 399 | typescript:S7763 | Use `export…from` to re-export `OpenAICompletionsCompat`. |
| src/session/jsonl.ts | 195 | typescript:S6606 | Prefer using nullish coalescing operator (`??=`) instead of an assignment expression, as it is simpler to read. |
| src/session/session-manager.ts | 430 | typescript:S6582 | Prefer using an optional chain expression instead, as it's more concise and easier to read. |
| src/skills/skills.ts | 66 | typescript:S6582 | Prefer using an optional chain expression instead, as it's more concise and easier to read. |
| src/tools/vault-tools.ts | 239 | typescript:S7786 | `new Error()` is too unspecific for a type check. Use `new TypeError()` instead. |
| src/ui/approval-modal.ts | 278 | typescript:S6606 | Prefer using nullish coalescing operator (`??=`) instead of an assignment expression, as it is simpler to read. |
| src/vault/path.ts | 17 | typescript:S7781 | Prefer `String#replaceAll()` over `String#replace()`. |
| src/vault/search.ts | 79 | typescript:S7780 | `String.raw` should be used to avoid escaping `\`. |
| src/vault/search.ts | 80 | typescript:S7781 | Prefer `String#replaceAll()` over `String#replace()`. |
| src/vault/search.ts | 81 | typescript:S7781 | Prefer `String#replaceAll()` over `String#replace()`. |
| test/mocks/obsidian.ts | 69 | typescript:S2094 | Unexpected empty class. |
| styles.css | 44 | css:S1874 | Deprecated keyword "break-word" for property "word-break" |
| test/mocks/obsidian.ts | 27 | typescript:S7781 | Prefer `String#replaceAll()` over `String#replace()`. |
| test/mocks/obsidian.ts | 42 | typescript:S2094 | Unexpected empty class. |
| test/mocks/obsidian.ts | 45 | typescript:S2094 | Unexpected empty class. |
| test/mocks/obsidian.ts | 46 | typescript:S2094 | Unexpected empty class. |
| test/mocks/obsidian.ts | 68 | typescript:S2094 | Unexpected empty class. |

---

## Summary by rule

| Rule | Type | Severity | Count |
|------|------|----------|-------|
| typescript:S8786 | CODE_SMELL | MAJOR | 49 |
| typescript:S3358 | CODE_SMELL | MAJOR | 30 |
| typescript:S7781 | CODE_SMELL | MINOR | 30 |
| typescript:S4624 | CODE_SMELL | MAJOR | 21 |
| typescript:S7780 | CODE_SMELL | MINOR | 21 |
| typescript:S3776 | CODE_SMELL | CRITICAL | 20 |
| typescript:S7744 | CODE_SMELL | MINOR | 18 |
| typescript:S7758 | CODE_SMELL | MINOR | 17 |
| typescript:S6582 | CODE_SMELL | MINOR | 10 |
| javascript:S8786 | CODE_SMELL | MAJOR | 9 |
| typescript:S7778 | CODE_SMELL | MINOR | 9 |
| typescript:S4144 | CODE_SMELL | MAJOR | 5 |
| typescript:S6571 | CODE_SMELL | MINOR | 5 |
| typescript:S7786 | CODE_SMELL | MINOR | 5 |
| typescript:S6606 | CODE_SMELL | MINOR | 5 |
| typescript:S2094 | CODE_SMELL | MINOR | 5 |
| javascript:S3776 | CODE_SMELL | CRITICAL | 4 |
| typescript:S5843 | CODE_SMELL | MAJOR | 4 |
| typescript:S3863 | CODE_SMELL | MINOR | 4 |
| css:S4666 | CODE_SMELL | MAJOR | 3 |
| typescript:S7784 | CODE_SMELL | MINOR | 3 |
| typescript:S7772 | CODE_SMELL | MINOR | 3 |
| typescript:S2004 | CODE_SMELL | CRITICAL | 2 |
| typescript:S2933 | CODE_SMELL | MAJOR | 2 |
| typescript:S4043 | CODE_SMELL | MAJOR | 2 |
| typescript:S4782 | CODE_SMELL | MAJOR | 2 |
| typescript:S5869 | CODE_SMELL | MAJOR | 2 |
| typescript:S6557 | CODE_SMELL | MAJOR | 2 |
| javascript:S7781 | CODE_SMELL | MINOR | 2 |
| typescript:S6594 | CODE_SMELL | MINOR | 2 |
| typescript:S7776 | CODE_SMELL | MINOR | 2 |
| typescript:S7754 | CODE_SMELL | MINOR | 2 |
| typescript:S6551 | CODE_SMELL | MINOR | 2 |
| jssecurity:S8705 | VULNERABILITY | MAJOR | 1 |
| javascript:S7785 | CODE_SMELL | MAJOR | 1 |
| typescript:S107 | CODE_SMELL | MAJOR | 1 |
| typescript:S2310 | CODE_SMELL | MAJOR | 1 |
| typescript:S7761 | CODE_SMELL | MAJOR | 1 |
| typescript:S6653 | CODE_SMELL | MINOR | 1 |
| typescript:S7765 | CODE_SMELL | MINOR | 1 |
| typescript:S6353 | CODE_SMELL | MINOR | 1 |
| javascript:S7758 | CODE_SMELL | MINOR | 1 |
| javascript:S7780 | CODE_SMELL | MINOR | 1 |
| javascript:S6353 | CODE_SMELL | MINOR | 1 |
| typescript:S7773 | CODE_SMELL | MINOR | 1 |
| typescript:S6644 | CODE_SMELL | MINOR | 1 |
| typescript:S7747 | CODE_SMELL | MINOR | 1 |
| typescript:S7750 | CODE_SMELL | MINOR | 1 |
| typescript:S5906 | CODE_SMELL | MINOR | 1 |
| typescript:S7763 | CODE_SMELL | MINOR | 1 |
| css:S1874 | CODE_SMELL | MINOR | 1 |

