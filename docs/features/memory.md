# Memory (session-fed distillation into MEMORY.md)

Off by default. Enable in **Settings → Agent → Memory**.

Two inputs, one distilled file. Only MEMORY.md auto-loads into every new chat (capped at ~8k chars ≈ 2k tokens of context per turn):

| Input | File | Written | Cost |
| --- | --- | --- | --- |
| Explicit notes | `<store>/daily/YYYY-MM-DD.md` | `remember_memory` / `/memory add` / compaction-summary deposits | Zero tokens (direct append) |
| Past sessions | Session JSONL (read on demand) | Every chat, automatically | Zero tokens until distilled |
| Distilled output | `<store>/MEMORY.md` | Idle 10min, startup sweep, session switch, or `/memory distill` | Typically ~1-2k tokens per run (bounded feedstock, ≤2k output tokens) |

## Where files live

**Settings → Agent → Memory → Memory location** (default: plugin folder):

- **Plugin folder (default, hidden):** `<vault>/.obsidian/plugins/agentic-chat/memory/` — stays on this device, hidden in the explorer.
- **Vault folder (synced):** `<vault>/<folder>/` (default folder `memory`) — syncs like any note, visible in the explorer. Two devices distilling at once last-writer-wins on the auto-section (rare; sync keeps conflict copies, nothing is silently lost).

Disabling orphans files by default; a **Delete files** button appears while disabled (purges MEMORY.md, its `.prev` backup, dailies, legacy files, and distill state).

## When it runs

- A session becomes eligible when it holds content not yet distilled (tracked per session, no thresholds on your side). Trivial chatter is skipped silently (under ~3 user turns / ~500 chars of new content distills nothing).
- Distillation runs automatically (10min idle, startup sweep, session switch) or manually via `/memory distill`. Auto runs are silent and sequential (≤3 sessions per run, newest first); each success logs one `distilled: …` line to today's daily note. Failures back off 24h and retry on the next trigger; each failure logs `distill failed: …`.
- No repeat work: distilled sessions are skipped until new messages arrive; resumed sessions distill only the delta.
- Offline or no API key: automatic runs skip (at most one log line per day); manual `/memory distill` still merges deterministically with zero tokens.
- Spend cap reached: automatic runs skip, counting foreground session + background distill spend together (an explicit manual `/memory distill` still runs — your direct request is consent for one small call).

## What's sent to the model

- The distiller receives recent session transcripts (thinking stripped, tool results capped, framed as untrusted DATA — never followed as instructions) + explicit daily notes + the existing MEMORY.md auto-section, and returns the full revised bullet list (≤30 bullets, ≤200 chars each). Human-written section of MEMORY.md is never sent for rewrite, only preserved.
- Contradictions resolve surgically: replaced facts drop out, unrelated facts stay byte-identical. Offline fallback merges deterministically (cannot resolve contradictions without a model).
- Loaded back into context: MEMORY.md (capped) as a `## Long-term memory` system-prompt block.

## Redaction limits

Daily/MEMORY.md plaintext may contain session summaries. Automatic filters block bearer/basic auth, `sk-`/`pk-`/`rk-`/`or-` style provider keys, `password=`-style assignments, and long alphanumeric blobs; secret- or instruction-shaped `/memory add` / `remember_memory` text is refused; directive-shaped distiller output is dropped. They do **not** cover every secret shape (e.g. `ghp_`/`AKIA` keys without a nearby keyword, PEM blocks) and do **not** do NER — names, emails, and vault content you discussed can be remembered. The file header and settings note say: *may contain session summaries — review before sharing the vault.*

## Review / delete

- Review: **Open MEMORY.md** / **Open today's note** buttons in settings, or open the files directly (edits to MEMORY.md above the `<!-- AGENTIC-CHAT-AUTO-MEMORY -->` marker are never overwritten — distillation rewrites only below it; the previous version is kept as `MEMORY.md.prev`).
- The agent can only append to **today's daily note** (`remember_memory` — say "remember this"; follows your mutating approval gate like any vault write, blocked in plan mode). It can never write MEMORY.md: generic `write`/`edit` to memory paths is denied even in YOLO, for parent and subagents (children never receive `remember_memory`; explorers may receive read-only `recall_memory`).
- Manual: `/memory add <text>` appends to today's daily note. `/memory distill` forces consolidation now.
- Recall: `recall_memory` (read-only, plan-allowed, child-grantable) searches MEMORY.md + recent daily notes with `{query, maxResults?}` and returns ≤500-char snippets with `[MEMORY]`/`[daily DATE]` citations as untrusted DATA. Never scans session JSONL in v1.
- Legacy `memories.jsonl` (old `search_memory` system) migrates once into MEMORY.md on first distill (`memories.jsonl.migrated` backup); `search_memory` and `/memory review|manage|export|clear` are removed.

## Disable

Turn off **Enable vault memory**: writing and loading stop immediately. Files are orphaned until you press **Delete files**.
