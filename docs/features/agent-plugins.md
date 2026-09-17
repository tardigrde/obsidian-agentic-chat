# Agent Plugins

Agent plugins are packages in the vault that follow the [Agent Plugins 1.0.0 specification](https://agent-plugins.org). Each package is a folder containing a `plugin.json` manifest plus optional `skills/` and `mcp.json` components — the plugin folder is where skills and MCP servers are defined.

## Layout

Plugins live in `.agentic-plugins/` at the vault root (configurable in Settings → Resources → Plugins folder):

```text
.agentic-plugins/
└── my-plugin/
    ├── plugin.json          # required: name, version, description
    ├── skills/
    │   └── summarize/
    │       └── SKILL.md     # skill name + description from frontmatter
    └── mcp.json             # optional: mcpServers map
```

- **Skills** — each folder under `skills/` holds a `SKILL.md`. The frontmatter `name` and `description` feed the skill registry; the body is the skill content. Plugin skills load first, so a plugin skill of the same name shadows a built-in.
- **MCP** — `mcp.json` declares `mcpServers` (currently `streamable-http` only). Servers whose transport is unsupported are skipped; valid ones load with their persisted client state (enable toggle, approval, auth, OAuth) preserved by id. Exposed tool names are `mcp__<server-id>__<tool>`, where the server id is derived from the package and server key.

A plugin with only an `mcp.json` (no skills) is valid — MCP-only plugins are allowed by the spec.

A plugin with neither `skills/` nor `mcp.json` (manifest only) is also valid: per §6.2 a missing
component location is not an error, so the loader reports it `ok` with 0 skills / 0 servers.
Your personal space is the `my-skills` package (`skills/<name>/SKILL.md` inside it): created only
when absent, never overwritten, restored on restart if deleted.

> **Built-ins can go stale.** The `builtins` package is a materialized copy — created when missing,
> never auto-updated. After a plugin update, hit **Repair built-ins** (Resources tab) to refresh it.
> Vault edits always win over bundled text.

## Creating plugins

The settings UI writes real packages for you:

- **MCP tab → Add MCP server** — enter a server name and an HTTPS (or loopback HTTP) endpoint, hit **Add MCP server**, and a package is created with that server's `plugin.json` + `mcp.json`. You then configure authentication, approval, and enable state from the same tab; endpoint and literal headers remain owned by the package.
- **Resources tab → New skill…** — scaffold a single-skill package (`skills/<name>/SKILL.md`) with a ready-to-fill template. The agent has the same capability in chat via the `create_skill` tool (same writer, always approval-gated — YOLO never auto-approves it, the package replaces same-named ones only after explicit confirmation, and created packages are not undoable via `/undo`).

Known limitation: generic file tools (`read`, `ls`) fall back to disk when the vault index is stale
(e.g. dot-folders created outside the session), but `edit`/`rename`/`delete` are still index-only —
editing an installed skill's files may need an Obsidian restart to re-index first. Skill *creation*
always works via `create_skill` / the wizard regardless.

## Importing plugins

**Resources tab → Install plugin…** brings packages into the vault from a GitHub URL, an archive, or a vault folder (desktop). See [Installing agent plugins](../guide/install.md#installing-agent-plugins) for the supported input shapes.

- Claude / Copilot / VS Code packages are converted to Agent Plugins 1.0 on import (skills copied whole, `mcpServers` → `mcp.json`, unsupported fields dropped with warnings).
- Imported packages show their install provenance (`Source:` line, e.g. `github:user/repo`) and can be **Removed** from the Resources tab, which also deletes any MCP servers the package contributed.
- Importing over an existing name updates it in place.
- Marketplace catalogs (`marketplace.json`) are shown as a pick list; `./`-relative entries install directly, git/archive entries list their fetch instructions.

## Built-in skill package

On first load, Agentic Chat materializes a `builtins` package in the plugins folder with the self-knowledge, deep-research (web mode), and install-plugin skills, so built-ins behave exactly like plugin skills (and a plugin skill with the same name can shadow them). The package is only materialized if missing — edits are never overwritten. If it is deleted, recreate it with **Resources → Repair built-ins**.

## Managing plugins

- **Resources tab → Installed plugins** — per-plugin enable toggles, spec-compliance status, component counts, and open-folder shortcuts.
- **`/doctor`** in chat — one health panel: aggregate status, then every package audited (manifest validation, skill counts, MCP server counts, skipped transports, and any spec violations) plus full runtime diagnostics.

## Spec compliance

- Vendored 1.0.0 JSON Schemas (`plugin.schema.json`, `mcp.schema.json`) validate every package on load.
- A fatal manifest violation rejects only that plugin; failures inside one plugin never affect the others.
- Packages are plain vault files: version-controllable, exportable with your vault, and readable on any device — no Node runtimes involved, so the same packages work on desktop and mobile.
