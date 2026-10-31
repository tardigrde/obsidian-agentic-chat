# Jev AutoMode tool-risk gating (opt-in)

Adapts LangChain's
[AutoModeMiddleware](https://www.langchain.com/blog/building-a-harness-with-jev)
([docs](https://docs.langchain.com/oss/python/integrations/providers/typesafe#tool-risk-gating)):
classify a proposed tool call as risky *before* it executes, and refuse it
instead of running the tool. Jev primer:
https://typesafe.ai/blog/introducing-system-one-models-and-jev

## Block vs escalate

- `mode: "block"` (default): confidently-risky calls are denied with a
  reason (user sees confidence + egress note). No modal.
- `mode: "escalate"`: risky calls route to the ask modal with a Jev audit
  note; the user decides. Pair `block` with human-in-the-loop for the rest,
  per LangChain's warning.

## Scope (important)

- Gated: `delete`, `rename`, `create_skill`, `load_skill`, `unload_skill`,
  all `mcp__*`, subagent dispatches, + user `tools` allowlist.
- NOT gated by default: `write`/`edit` (reversible via undo, ask-gated in
  Safe mode), plain reads. Pinned by test.
- Allow paths ONLY. `deny`/`ask` (incl. Safe-mode destructive asks and
  forced recursive-delete asks) never scan — existing prompts already
  protect those.

## Enable (all three required)

1. `settings.jev.autoMode.enabled = true`
2. `settings.jev.autoMode.allowEgress = true` — redacted tool args leave the
   device to `api.typesafe.ai`. Inherent trade: classification egress happens
   *before* the block decision, so blocking an exfiltration still sends the
   redacted description to TypeSafe. Do not enable with secrets in tool args
   unless that trade is acceptable.
3. TypeSafe API key in secretStorage (same slot as sibling PRs).

Plugin settings are per-vault (`data.json` per vault), so `allowEgress` is
already per-vault consent.

## Budgets

One assessment per gated allow max; redacted-state memo (60s TTL, 200
entries); 300 scans/session then fail-open with a one-time console warning;
300ms default timeout (50–2000 clamp). Landing alongside PR #159 doubles
gate egress (two independent scans) — follow-up: share one request.

## Overlap note

Sibling PRs #159 (injectionGuard) and #160 (rerank) share the `jev` block,
apiKey slot, and client (near-identical; this branch also fixes a chained
parse rejection). Healers preserve-forward unknown keys; rebase additively.

## Files

- `src/agent/jev-automode.ts` — assessor + gated-tool matcher.
- `src/agent/tool-call-controller.ts` — allow-path wiring (vault/MCP/dispatch).
- Settings/slot/tests as in siblings.
