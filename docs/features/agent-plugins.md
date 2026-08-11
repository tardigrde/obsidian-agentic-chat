# Agent Plugins

Agent plugins are packages in the vault that follow the [Agent Plugins 1.0.0 specification](https://agent-plugins.org). Each package is a folder containing a `plugin.json` manifest plus optional `skills/` and `mcp.json` components. Agentic Chat treats the plugin folder as the **single source of truth** for skills and MCP servers.

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

- **Skills** — each folder under `skills/` holds a `SKILL.md`. The frontmatter `name` and `description` feed the skill registry; the body is the skill content. Built-in skills load first, and a plugin skill of the same name wins.
- **MCP** — `mcp.json` declares `mcpServers` (currently `streamable-http` only). Servers whose transport is unsupported are skipped; valid ones load with their persisted client state (enable toggle, approval, auth, OAuth) preserved by id. Tool names use the id `mcp__plugin_<name>_<key>__<tool>`.

A plugin with only an `mcp.json` (no skills) is valid — MCP-only plugins are allowed by the spec.

## Creating plugins

The settings UI writes real packages for you:

- **MCP tab → Add MCP server** — enter a server name and HTTPS endpoint, hit **Generate plugin**, and a package is created with that server's `plugin.json` + `mcp.json`. You then configure authentication, approval, and enable state from the same tab; endpoint and headers remain owned by the package.
- Earlier versions of the plugin stored MCP servers directly in settings. On upgrade, HTTPS (and loopback-HTTP) servers are migrated once into a `legacy-mcp` package with their client-owned state remapped; re-authorize if needed. Servers that cannot run under an agent plugin (for example `http://` on a non-loopback host) are left in place and reported in a notice.
- Earlier versions also loaded skills and templates from vault folders set in settings. Those documents are migrated once into an `agentic-skills` package (templates only when no skill of the same name exists); the folder settings themselves are removed.
- Both migrations are crash-safe: a package left behind by an interrupted run is reused, never duplicated.

## Managing plugins

- **Resources tab → Installed plugins** — per-plugin enable toggles, spec-compliance status, component counts, and open-folder shortcuts.
- **`/doctor`** in chat — one health panel: aggregate status, then every package audited (manifest validation, skill counts, MCP server counts, skipped transports, and any spec violations) plus full runtime diagnostics.

## Spec compliance

- Vendored 1.0.0 JSON Schemas (`plugin.schema.json`, `mcp.schema.json`) validate every package on load.
- A fatal manifest violation rejects only that plugin; failures inside one plugin never affect the others.
- Packages are plain vault files: version-controllable, exportable with your vault, and readable on any device — no Node runtimes involved, so the same packages work on desktop and mobile.
