# Memory (Tier-1 daily + Tier-2 distilled)

Off by default. Enable in **Settings → Agent → Memory**.

Two tiers, both plain Markdown. Only MEMORY.md auto-loads into every new chat (capped at ~8k chars ≈ 2k tokens of context per turn); daily notes are distillation feedstock only:

| Tier | File | Written | Cost |
| --- | --- | --- | --- |
| Tier-1 daily | `<store>/daily/YYYY-MM-DD.md` | Session end (`/new`, tab/leaf switch/close, session switch, app close) + `remember_memory` / `/memory add` | Zero tokens (deterministic) |
| Tier-2 distilled | `<store>/MEMORY.md` | Idle 5min after Tier-1 (when ≥3 pending or >24h stale), Obsidian startup if pending, or `/memory distill` | Typically ~1-2k tokens (bounded by 5×2k-char dailies + MEMORY.md auto-section, ≤800 output tokens) |

## Where files live

**Settings → Agent → Memory → Memory location** (default: plugin folder):

- **Plugin folder (default, hidden):** `<vault>/.obsidian/plugins/agentic-chat/memory/` — stays on this device, hidden in the explorer.
- **Vault folder (synced):** `<vault>/<folder>/` (default folder `memory`) — syncs like any note, visible in the explorer.

Disabling orphans files by default; a **Delete files** button appears while disabled.

## When it runs

- Tier-1 captures only sessions with **≥3 user turns and ≥500 chars** — short chats are skipped silently. Bullets come from `remember that`/`I prefer`/`my X is…` phrases when present, otherwise the first substantive user message is quoted verbatim (sliced to 220 chars).
- Tier-2 runs automatically (idle/startup) or manually via `/memory distill`. Failures back off 24h and retry on the next trigger; each failure logs `distill failed: …` to today's daily note.
- Offline or no API key: automatic Tier-2 skips (at most one log line per day in today's daily note); manual `/memory distill` still merges deterministically with zero tokens. Tier-1 always works offline.
- Spend cap reached: automatic Tier-2 skips (an explicit manual `/memory distill` still runs — your direct request is consent for one small call).

## What's sent to the model

- Tier-1 sends nothing (regex + deterministic bullets, secrets filtered).
- Tier-2 sends recent daily notes (≤5, ≤2k chars each) + existing MEMORY.md auto-section to the **active chat model** (or the distill model override). Human-written section of MEMORY.md is never sent for rewrite, only preserved.
- Loaded back into context: MEMORY.md (capped) as a `## Long-term memory` system-prompt block.

## Redaction limits

Daily/MEMORY.md plaintext may contain session summaries. Automatic filters block bearer/basic auth, `sk-`/`pk-`/`rk-`/`or-` style provider keys, `password=`-style assignments, and long alphanumeric blobs, and refuse secret-like `/memory add` / `remember_memory` text. They do **not** cover every secret shape (e.g. `ghp_`/`AKIA` keys without a nearby keyword, PEM blocks) and do **not** do NER — names, emails, and vault content you discussed can be remembered. The file header and settings note say: *may contain session summaries — review before sharing the vault.*

## Review / delete

- Review: **Open MEMORY.md** / **Open today's note** buttons in settings, or open the files directly (edits to MEMORY.md above the `<!-- AGENTIC-CHAT-AUTO-MEMORY -->` marker are never overwritten — distillation merges below it).
- The agent can only append to **today's daily note** (`remember_memory` — say "remember this"; follows your mutating approval gate like any vault write, blocked in plan mode). It can never write MEMORY.md: generic `write`/`edit` to memory paths is denied even in YOLO, for parent and subagents (children never receive `remember_memory`; explorers may receive read-only `recall_memory`).
- Manual: `/memory add <text>` appends to today's daily note. `/memory distill` forces consolidation now.
- Recall: `recall_memory` (read-only, plan-allowed, child-grantable) searches MEMORY.md + recent daily notes with `{query, maxResults?}` and returns ≤500-char snippets with `[MEMORY]`/`[daily DATE]` citations as untrusted DATA. Never scans session JSONL in v1.
- Legacy `memories.jsonl` (old `search_memory` system) migrates once into MEMORY.md on first capture/distill (`memories.jsonl.migrated` backup); `search_memory` and `/memory review|manage|export|clear` are removed.

## Disable

Turn off **Enable vault memory**: writing and loading stop immediately. Files are orphaned until you press **Delete files**.
