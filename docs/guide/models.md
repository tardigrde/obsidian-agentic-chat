# Choosing a model

The agent works through tool calls, so the model must support **tool calling**
(function calling). Beyond that, you are trading off tool-use reliability,
cost, speed, privacy, and context window.

## Recommendation

**Use the default: `deepseek/deepseek-v4.1-flash` on OpenRouter.**

It is the model the project's agent eval suite runs on, so it is the one with
measured numbers. The latest committed `core` baseline (12 vault tasks, 3 runs
each, reasoning effort `low`):

| Axis | Result |
| --- | --- |
| Correctness | 92% of tasks passed on all 3 runs; 94% of single runs passed |
| Cost | about **$0.002 per task** (~41k tokens, billed by the provider) |
| Speed | 7.5 s median per task |

The tasks are real vault jobs: find, edit, organize, create, frontmatter, safety
traps, and recovery from stale state. Method and caveats:
[Evals](../development/evals.md#tool-use-evals).

Other models work, but they are not measured here. If you switch, re-check
approval prompts and edits on a test note first.

## Picking another model

| You care most about | Choose |
| --- | --- |
| Cheapest reliable tool use | The default |
| Hardest reasoning or long research | A larger frontier model on OpenRouter, plus `/effort high` |
| Nothing leaves your machine | Ollama with a tool-capable model (see below) |
| A company gateway | **OpenAI-compatible** provider with the gateway's model id |

In **Settings → Models → Model → Browse**, the list shows only models that
support tools. While zero-data-retention routing is on, it shows only models
with a compliant endpoint.

To try a model for one prompt, Shift-click it in the composer's model picker.
The override is marked "next only" and reverts after the prompt.

## Privacy and model choice

With the strict defaults, OpenRouter sends requests only to endpoints that
retain nothing and do not log or train on prompts. Some models have no such
endpoint, so **Browse** hides them and requests fail with "no compliant
endpoint". Options:

1. Pick another model (the default has compliant endpoints).
2. Relax **Require zero data retention** or **Deny prompt logging** in
   *Settings → Models*, knowingly.
3. Run locally with Ollama.

Details: [Privacy model](./privacy.md#openrouter-routing).

## Local models (Ollama)

- Pick a tag that supports tools. Ollama marks them on its
  [model search](https://ollama.com/search?c=tools). The settings default is
  `llama3.1`.
- Small local models make more tool-call mistakes. Keep the composer on
  **Safe** so you review each edit.
- Set **Context window (tokens)** if compaction never triggers: the plugin
  detects windows from the OpenRouter catalog, which may not know your local tag.

## Reasoning effort

`/effort <level>` (or the composer knob) sets how much the model thinks:
`off`, `minimal`, `low`, `medium`, `high`, `xhigh`. Models without reasoning
support ignore it.

- `off` (default) sends no parameter; the provider decides. For DeepSeek v4.1
  Flash that can mean its own `high` default on some routes and none on others.
- `low` is what the evals measure. Pick it when you want consistent cost.
- `high` / `xhigh` for planning and research. They cost more tokens.

## What a session costs

You pay your provider per token. The plugin shows:

- per-message and per-session tokens and USD (`/usage`, `/status`)
- a next-request estimate and a context-fill bar in the composer
- a one-time **Cost alert (USD)** and a **Hard spend cap (USD)**
  (*Advanced → Notifications*, both off at `0`)

What drives cost: the size of notes the agent reads, the number of turns, and
the system prompt plus tool schemas sent on every request. Keep sessions focused
(`/new` per task), let compaction run, and hand recon to the Explorer subagent.
Prices come from OpenRouter's public catalog, refreshed every three days.
