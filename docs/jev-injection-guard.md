# Jev injection guard (opt-in)

[Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev) is a
System One model: `state + questions → typed probabilistic decisions`
(`noul` / `choice` / `score`), 70–500ms, no string generation. Pattern follows
LangChain [AutoMode](https://www.langchain.com/blog/building-a-harness-with-jev):
classify risky actions *before* executing.

## What it does

Two `noul` questions (`prompt_injection`, `jailbreak`) evaluated **in parallel**
in one request over redacted tool args. High-confidence hits escalate an
otherwise auto-allowed call (`allow` → `ask` modal). Deny/ask paths are
untouched; the user stays the final approver. Everything fails open: disabled,
keyless, egress-unacknowledged, timeout, malformed, or low-confidence ⇒ allow
(plus audit trail).

## Enable (all three required)

1. `settings.jev.injectionGuard.enabled = true`
2. `settings.jev.injectionGuard.allowEgress = true` — explicit acknowledgement
   that **redacted** tool args leave the device to `api.typesafe.ai`
   (no ZDR/no-train contract;step outside the default zero-retention posture).
3. TypeSafe API key in secretStorage (`jev.apiKeySecretId`, default
   `agentic-chat-typesafe-api-key`; hydrated at startup like all secrets,
   never persisted to `data.json`).

## Scope & budgets (to bound spend/latency)

- Scanned: mutating tools, MCP tools, subagent dispatches, and risky reads
  (`fetch_url`, `web_search`, `load_skill`, `unload_skill`). Plain reads skip.
- One request per auto-allowed call max; memoized per tool+args (60s TTL, 200
  entries); capped at 300 scans/session; 300ms default timeout (50–2000 clamp).
- ~600–700 input tokens/scan. `costCapUsd` does not cover Jev yet (follow-up).

## Files

- `src/agent/jev-client.ts` — transport-injectable client (prod: `requestUrl`).
- `src/agent/jev-injection.ts` — scanner + `JEV_SCAN_READ_TOOLS` + cache consts.
- `src/agent/tool-call-controller.ts` — `jevScanArgs` wired into vault/MCP
  allow paths + subagent dispatch allow paths.
- `src/settings-schema.ts` — `jev` settings + healing; `src/secrets/secret-store.ts` — slot.
