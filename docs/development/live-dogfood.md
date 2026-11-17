# Live dogfood runbook

Maintainer runbook for bug sweeps in a real Obsidian with a real model. It is
exploratory: it finds bugs, it does not prove anything. Proof is a
deterministic test (see [testing.md](testing.md)).

## Two modes

| mode | command | model | use |
|---|---|---|---|
| scripted | `npm run verify -- app --dogfood` | scripted replay | generated adversarial vault + oracle; runs in CI |
| manual live | `npm run dogfood -- "$TARGET_VAULT"` | your gateway | human-in-the-loop debugging in a real vault |

The scripted run writes `logs/dogfood-runs/<run-id>/` (vault, sessions, report).

## Safety

- Never paste a key into chat, source, docs, fixtures, or artifacts. Keep it in
  `.env` or a local key file.
- Never commit `<vault>/.obsidian/plugins/agentic-chat/data.json`, `sessions/`,
  or `artifacts/`.
- Use the user's real vault only with explicit approval. Prefer a throwaway
  copy, and write under one folder such as `Agentic Chat Dogfood/`.
- Live output is nondeterministic. Never use it as a pass/fail assertion.

## Setup

```bash
set -a; . ./.env; set +a
export TARGET_VAULT="$HOME/AgenticChatDogfoodVault"
export AGENTIC_CHAT_BASE_URL="https://openrouter.ai/api/v1"
export AGENTIC_CHAT_MODEL="openrouter/auto"
export NO_PROXY="localhost,127.0.0.1,::1"

npm run verify -- check --no-app          # sanity first
npm run install:local -- "$TARGET_VAULT"  # or: npm run dev:vault -- "$TARGET_VAULT"
```

In the plugin settings: provider `OpenAI-compatible`, the base URL, the key,
the model, mode Safe.

## What to exercise

Keep each scenario in its own session. Start small:

1. "Explore the vault and write a short index note at
   `Agentic Chat Dogfood/index.md`. Ask before writing."
2. Read and summarize a topic cluster into one note.
3. Deny one edit approval, then continue with a narrower request.

Then the sad paths a naive user hits:

- model: switch before a turn, after a failed turn, invalid or empty id
- unclear asks: "clean this up", "delete the bad notes" (the agent must ask)
- approvals: deny write, deny delete, change approval settings mid-session,
  close the modal, double-click
- context: huge active note, ignored note, several attached notes
- MCP: disabled, bad URL, deny/allow, tool failure
- lifecycle: reload the plugin mid-workflow, switch sessions, `/export`, `/undo`

## Read the trace

```bash
npm run analyze:session -- <sessions-dir> --format markdown
npm run analyze:session -- --compare <before-dir> <after-dir> --format markdown
npm run trace:mine -- --sessions <sessions-dir>
```

Look for repeated tool calls, token-heavy turns, cache misses, unexpected
active-note context, and failed tool calls. Extend the analyzer before you read
raw JSONL by hand. Details: [evals.md](evals.md#trace-mining).

## Record a bug

One entry per bug in a local `DOGFOOD_BUGS.md` (not committed):

```markdown
## BUG-YYYYMMDD-NN: Short title
Severity / Area / Vault / Model / Plugin commit / Obsidian version
Repro: 1. … 2. … 3. …
Expected: …   Actual: …
Artifacts: logs/e2e-artifacts/…, session JSONL, redacted settings
```

Redact keys, private URLs, and unrelated note content before you copy anything.

## Fix loop

1. Reproduce once (live or manual).
2. Fix the smallest code path.
3. Pin it with a deterministic test: unit for logic, a scripted app spec for UI
   or approvals, a replay (`test/helpers/agent-replay.ts`) for an agent flow.
   A provider-only issue stays a live spec in `test/e2e/live/`.
4. Run the commands `npm run verify -- plan` prints.
5. Reinstall and re-run the live scenario that found it.

Never turn a flaky live path into a CI gate.

## Live dogfood specs

`test/e2e/dogfood/marketplace-live.dogfood.ts` installs the `swe` package from
`tardigrde/ai-marketplace` (pinned to commit `20bedd4`; bump `MARKETPLACE_REF`
after review) and drives a `/skill` call, a Context7 MCP round trip, and
`/doctor`. `subagent-live.dogfood.ts` needs `AGENTIC_CHAT_SUBAGENT_DOGFOOD=true`.
Both spend tokens:

```bash
AGENTIC_CHAT_API_KEY=... AGENTIC_CHAT_MODEL=openrouter/auto \
  npm run test:e2e:dogfood -- --spec test/e2e/dogfood/marketplace-live.dogfood.ts
```

Overrides: `AGENTIC_CHAT_MARKETPLACE_URL`, `AGENTIC_CHAT_MARKETPLACE_PATH`.

## At the end

Report bugs found, fixes made, tests run, and whether the patched plugin is
installed in `TARGET_VAULT`. Leave unrelated worktree changes alone.
