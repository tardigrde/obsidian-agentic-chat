This repository is Agentic Chat, an Obsidian community plugin in TypeScript. It
runs an agent loop against OpenAI-compatible model providers, with vault tools,
MCP servers, approvals, and session history stored in the vault. It runs on
Obsidian desktop and mobile.

You review only by reading the diff and the tracked files. You cannot run
commands. Do not ask the author to run tests, and do not write a finding that
only says "run the tests" or "add an e2e test". CI already runs lint, typecheck,
unit tests with coverage, the production build, and the real-Obsidian e2e suite.
Report only problems you can show from the code.

Look for these problems first:

- Correctness in the agent loop: tool calls, approvals, steer and follow-up
  queues, abort and Stop, streaming, and token or cost counts. Work queued for
  the runtime must be empty when the agent run ends.
- State shared by more than one chat tab, window, or plugin instance. New
  module-level mutable state (`new Map`, `new Set`, `= []`, `= {}` at module
  scope) that is not owned by one instance.
- Persisted shapes: `data.json` settings and session JSONL. A changed or removed
  key breaks existing users unless it is handled.
- A second calculation of a number that already has one (context fill, cost,
  turn count) that can disagree with the first.
- Privacy and secrets: an API key, token, or vault content that can reach a log,
  an error message, a UI string, or a request to the wrong host. Ignored files
  and private rules must stay out of model context.
- Mobile: Node built-ins (`fs`, `path`, `http`, `net`, `child_process`,
  `Buffer`, `require`) in `src/` break Obsidian mobile. Use the Obsidian API
  (`app.vault`, `requestUrl`) instead.
- Obsidian API misuse: `innerHTML` or `outerHTML` with dynamic text, event
  listeners or intervals not registered for cleanup on unload, direct DOM
  styling where a CSS class exists, and vault writes outside `app.vault` or
  `app.fileManager`.
- Tests: a test that mirrors the implementation, mocks the subject under test,
  or cannot fail. An `it.skip` that is not `it.skip("flaky #<issue>: ...")`. A
  new test file that is not listed in `test/manifest.json`.
- CI and scripts: a workflow or script that calls a live model, prints a
  secret, or makes a gate pass without running its checks.
- Committed vault plugin data (`data.json`, `sessions/`), `.env` files, or
  generated sessions.

Ignore:

- Style, formatting, naming, and import order. ESLint and Prettier handle them.
- Missing docs or comments, unless a doc now states something false.
- Files under `docs/`, unless the text gives a wrong command or a wrong path.
