# Troubleshoot

If something fails, match the symptom below. Run `/doctor` first for config problems — it audits runtime health, agent plugins, and MCP servers in one panel.

## No model answers

| Symptom | Fix |
| --- | --- |
| Model list is empty or a model reports no compliant endpoint | Strict privacy routing is filtering everything out. Pick another model, or deliberately relax **Require zero data retention** / **Deny prompt logging** in settings. |
| `Invalid API key` / `401` | Repaste the key in **Settings > Agentic Chat > Models**. OpenRouter keys come from [openrouter.ai/keys](https://openrouter.ai/keys). |
| Ollama `connection refused` | Start the Ollama server and keep the default URL `http://localhost:11434` unless yours is elsewhere. No API key is needed. |
| Gateway errors on OpenWebUI / LM Studio / vLLM | Set the base URL to the gateway root whose `/chat/completions` endpoint is valid (`http://localhost:3000/api` for OpenWebUI). Paste the bearer token and the exact model id the gateway exposes. |
| `net::ERR_NO_SUPPORTED_PROXIES` (desktop) | The proxy must be `http://host:port` (http only, no trailing slash). On mobile, leave plugin proxy fields empty and use the device or VPN proxy. |
| Timeouts on long answers | Raise **Request timeout** (default 90s) or lower **Max response tokens**; **Network retries** defaults to 2. |

## The agent won't touch my notes

| Symptom | Fix |
| --- | --- |
| Reads act like the file doesn't exist | The path is probably on the ignore list — ignored files report as not found. Check **Approval > Ignore patterns**. |
| Every write asks for approval | That is Safe mode doing its job. Grant the folder with `/add-dir <folder>`, set per-tool policy under **Approval**, or switch posture with `/config` (YOLO auto-approves for the session; per-tool deny still wins). |
| Stuck in read-only mode | `/plan` is sticky. Click the **Plan** badge in chat or run `/config` to switch back to Safe/YOLO. |
| A denied tool keeps getting blocked | Per-tool **deny** overrides everything, including YOLO. Change it under **Approval > Per-tool overrides**. |

## Cost and context

| Symptom | Fix |
| --- | --- |
| `Cost cap reached`, new turns blocked | Raise or disable **Cost cap** under **Notifications** (0 disables), then continue. Check spend any time with `/usage`. |
| Cost alert toast | One-time notice at your **Cost alert** threshold (0 disables). Informational only. |
| Old turns disappearing | Auto-compaction summarized them at 80% context fill (default). Reopen large outputs via artifact references, or run `/compact [instructions]` manually to control what survives. |
| Unknown context window disables compaction | The OpenAI-compatible provider couldn't match the model slug. Set **Context window (tokens)** explicitly (0 = auto-detect). |

## Indexing and memory

| Symptom | Fix |
| --- | --- |
| The agent doesn't recall a stored memory | Memories are never auto-injected — the agent must call `search_memory`. Ask explicitly ("What do you remember about…") or check `/memory review`. |
| Semantic index build fails | Check embedding model id and vector dimensions match (default 1536), and that the embedding provider key is set — it reuses the **Models** tab secrets. See `/semantic-index status`. |
| Edited skill files not picked up | Restart Obsidian to re-index (dot-folders created outside Obsidian can be stale), or run **Repair built-ins** on the Resources tab. |

Still stuck? Run `/status` (provider, model, mode, session, MCP) and include its output when reporting the issue.
