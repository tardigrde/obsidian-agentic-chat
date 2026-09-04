# Memory (Tier-1 daily + Tier-2 distilled)

Off by default. Enable in **Settings → Agent → Memory**.

Two tiers, both plain Markdown, both auto-loaded into every new chat (capped at ~8k chars):

| Tier | File | Written | Cost |
| --- | --- | --- | --- |
| Tier-1 daily | `<store>/daily/YYYY-MM-DD.md` | Session end (`/new`, tab switch/close, app close) + `remember_memory` / `/memory add` | Zero tokens (deterministic) |
| Tier-2 distilled | `<store>/MEMORY.md` | Idle 5min after Tier-1 (when ≥3 pending or >24h stale), Obsidian startup if pending, or `/memory distill` | Concise, ~1-2k tokens |

## Where files live

**Settings → Agent → Memory → Memory location** (default: plugin folder):

- **Plugin folder (default, hidden):** `<vault>/.obsidian/plugins/agentic-chat/memory/` — stays on this device, hidden in the explorer.
- **Vault folder (synced):** `<vault>/<folder>/` (default folder `memory`) — syncs like any note, visible in the explorer.

Disabling orphans files by default; a **Delete files** button appears while disabled.

## When it runs

- Tier-1 captures only sessions with **≥3 user turns and ≥500 chars** — short chats are skipped silently.
- Tier-2 runs automatically (idle/startup) or manually via `/memory distill`. One retry max, then backs off 24h and logs `distill skipped/failed` to today's daily note.
- Offline or no API key: Tier-2 skips silently (one log line in today's daily note). Tier-1 always works offline.
- Spend cap reached: Tier-2 skips.

## What's sent to the model

- Tier-1 sends nothing (regex + deterministic bullets, secrets filtered).
- Tier-2 sends recent daily notes (≤5, ≤2k chars each) + existing MEMORY.md auto-section to the **active chat model** (or the distill model override). Human-written section of MEMORY.md is never sent for rewrite, only preserved.
- Loaded back into context: MEMORY.md (capped) as a `## Long-term memory` system-prompt block.

## Redaction limits

Daily/MEMORY.md plaintext may contain session summaries. Automatic filters block bearer tokens, provider keys (`sk-…`), `password=`-style assignments, and high-entropy blobs, and refuse secret-like `/memory add` / `remember_memory` text. They do **not** do NER — names, emails, and vault content you discussed can be remembered. The file header and settings note say: *may contain session summaries — review before sharing the vault.*

## Review / delete

- Review: **Open MEMORY.md** / **Open today's note** buttons in settings, or open the files directly (edits to MEMORY.md above the `<!-- AGENTIC-CHAT-AUTO-MEMORY -->` marker are never overwritten — distillation merges below it).
- The agent can only append to **today's daily note** (`remember_memory` — say "remember this"). It can never write MEMORY.md: generic `write`/`edit` to memory paths is denied even in YOLO, for parent and subagents.
- Manual: `/memory add <text>` appends to today's daily note. `/memory distill` forces consolidation now.
- Legacy `memories.jsonl` (old `search_memory` system) migrates once into MEMORY.md on first capture/distill (`memories.jsonl.migrated` backup); `search_memory` and `/memory review|manage|export|clear` are removed.

## Disable

Turn off **Enable vault memory**: writing and loading stop immediately. Files are orphaned until you press **Delete files**.
