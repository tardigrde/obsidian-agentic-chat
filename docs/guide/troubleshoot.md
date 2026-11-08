# Troubleshoot

If something fails, find the symptom below. Run `/doctor` first for configuration problems. It audits runtime health, agent plugins, and MCP servers in one panel.

## No model answers

| Symptom | Fix |
| --- | --- |
| Model list is empty, or a model reports no compliant endpoint | Strict privacy routing is filtering out every endpoint. Pick another model, or relax **Require zero data retention** or **Deny prompt logging** in settings. |
| `Invalid API key` or `401` | Paste the key again in **Settings > Agentic Chat > Models**. OpenRouter keys come from [openrouter.ai/keys](https://openrouter.ai/keys). |
| Ollama `connection refused` | Start the Ollama server. Keep the default URL `http://localhost:11434` unless your server uses another address. No API key is needed. |
| Gateway errors on OpenWebUI, LM Studio, or vLLM | Set the base URL to the gateway root that serves `/chat/completions`. For OpenWebUI, use `http://localhost:3000/api`. Paste the bearer token and the exact model id that the gateway exposes. |
| `net::ERR_NO_SUPPORTED_PROXIES` (desktop) | Use `http://host:port` with no trailing slash. The plugin accepts only the http scheme. On mobile, leave the plugin proxy fields empty and use the device or VPN proxy. |
| Timeouts before the response starts | Raise **Request timeout** (default 90s). **Network retries** defaults to 2. |

## The agent cannot change my notes

| Symptom | Fix |
| --- | --- |
| Reads act like the file does not exist | The path is probably on the ignore list. Ignored files report as not found. Check **Advanced > Ignored files**. |
| Every write asks for approval | Safe mode asks before each write. Approve the call, set a per-tool policy under **Approval**, or switch the mode with the composer Safe/YOLO toggle or the **Permission mode** setting. YOLO auto-approves most mutating tools, but recursive folder deletes still ask and a per-tool deny still wins. |
| A denied tool stays blocked | A per-tool **deny** overrides everything, including YOLO. Change it under **Approval > Per-tool overrides**. |

## Cost and context

| Symptom | Fix |
| --- | --- |
| `Spend cap of $X reached`, new turns blocked | Raise or disable **Cost cap** under **Notifications** (`0` disables it), then continue, or start a new conversation. Check spend with `/usage`. The cap also stops the running turn when the conversation cost reaches the limit. |
| Cost alert toast | One notice when the conversation cost passes your **Cost alert** threshold (`0` disables it). The notice is informational. |
| Old turns disappear | Auto-compaction summarizes them at 80% context fill by default. Reopen large outputs through artifact references, or run `/compact [instructions]` to control what the summary keeps. |
| Unknown context window disables compaction | The plugin could not match the model slug in the OpenRouter catalog. Set **Context window (tokens)** explicitly (`0` means auto-detect). |

## Indexing and memory

| Symptom | Fix |
| --- | --- |
| The agent does not recall a stored memory | The plugin never injects memories automatically. The agent must call `search_memory`. Ask directly ("What do you remember about...") or check `/memory review`. |
| Semantic index build fails | Check that the embedding model id and vector dimensions match (default 1536). For a remote provider, check that its key is set. Embeddings reuse the **Models** tab secrets. See `/semantic-index status`. |
| Edited skill files are not picked up | Restart Obsidian to rebuild the vault index. Dot-folders created outside Obsidian can be stale. **Repair built-ins** refreshes only the `builtins` package and restores `my-skills` if it is missing. |

If these steps do not help, run `/status` (provider, model, mode, session, MCP) and include its output in the report.
