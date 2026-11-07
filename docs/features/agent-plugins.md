# Agent plugins

Agent plugins are packages in the vault that follow the [Agent Plugins 1.0.0 specification](https://agent-plugins.org). Each package is a folder with a `plugin.json` manifest and optional `skills/` and `mcp.json` components. The folder is the source for the skills and MCP servers it contributes.

## Layout

Plugins live in `.agentic-plugins/` at the vault root. You can change the folder in **Settings > Agentic Chat > Resources > Plugins folder**:

```text
.agentic-plugins/
└── my-plugin/
    ├── plugin.json          # required: $schema, name
    ├── skills/
    │   └── summarize/
    │       └── SKILL.md     # skill name + description from frontmatter
    └── mcp.json             # optional: mcpServers map
```

Each folder under `skills/` holds a `SKILL.md`. The `name` and `description` frontmatter fields feed the skill registry, and the body is the skill content. Plugin skills load before built-ins, so a plugin skill with the same name shadows the built-in.

`mcp.json` declares `mcpServers`, currently `streamable-http` only. The loader skips servers with an unsupported transport. Valid servers keep their client state by id: enable toggle, approval, auth, and OAuth. Tool names are `mcp__<server-id>__<tool>`. The server id comes from the package name and the server key.

A plugin with only `mcp.json` (no skills) is valid. The spec allows MCP-only plugins.

A plugin with only `plugin.json` is also valid. Per section 6.2, a missing component location is not an error, so the loader reports `ok` with 0 skills and 0 servers. The `my-skills` package is your personal collection (`skills/<name>/SKILL.md`). The plugin creates it when absent, never overwrites it, and restores it on restart if deleted.

> Built-ins can go stale. The `builtins` package is a materialized copy. The plugin creates it when missing and never updates it automatically. After a plugin update, click **Repair built-ins** on the Advanced tab (Agent plugins) to refresh it. Edits in the vault always win over the bundled text.

## Creating plugins

The settings UI writes real packages:

- **Advanced tab > MCP tools > Add MCP server**: enter a server name and an HTTPS (or loopback HTTP) endpoint, then click **Add MCP server**. The plugin creates a package with that server's `plugin.json` and `mcp.json`. Configure authentication, approval, and enable state in the same section. The package owns the endpoint and literal headers.
- **Advanced tab > Agent plugins > New skill…**: create a single-skill package (`skills/<name>/SKILL.md`) with a template. The `create_skill` tool does the same in chat. It defaults to ask, and YOLO never auto-approves it; a per-tool allow can override the default. It replaces a same-named package only after you confirm. `/undo` cannot revert a created package.

One limitation remains. Generic file tools (`read`, `ls`) fall back to disk when the vault index is stale, for example for dot-folders created outside the session. `edit`, `rename`, and `delete` use the index only. If you edit an installed skill's files, restart Obsidian to re-index first. Skill creation always works through `create_skill` or the wizard.

## Importing plugins

**Advanced tab > Agent plugins > Install plugin…** brings packages into the vault from a GitHub URL, an archive, or a vault folder (desktop only). See [Installing agent plugins](../guide/install.md#installing-agent-plugins) for the supported input shapes.

- The importer converts Claude, Codex, and Copilot or VS Code packages to Agent Plugins 1.0. It copies skills whole, converts `mcpServers` to `mcp.json`, and drops unsupported fields with warnings.
- Imported packages show their source (`Source:`, for example `github:user/repo`). **Remove** on the Advanced tab (Agent plugins) deletes the package and any MCP servers it contributed.
- Importing over an existing name updates it in place.
- Marketplace catalogs (`marketplace.json`) appear as a pick list. `./`-relative entries install directly. Git and archive entries list their fetch instructions.

## Built-in skill package

On first load, Agentic Chat creates a `builtins` package in the plugins folder. It holds the self-knowledge, deep-research (web mode), and install-plugin skills, so built-ins behave like plugin skills and a plugin skill with the same name can shadow them. The plugin only creates the package when missing and never overwrites edits. If you delete it, use **Resources > Repair built-ins**.

## Managing plugins

- **Advanced tab > Agent plugins > Installed plugins**: per-plugin enable toggles, spec status, component counts, and open-folder shortcuts.
- **`/doctor`** in chat: one health panel. It shows aggregate status, then audits every package (manifest validation, skill counts, MCP server counts, skipped transports, spec violations) and adds full runtime diagnostics.

## Spec compliance

- Vendored 1.0.0 JSON Schemas (`plugin.schema.json`, `mcp.schema.json`) validate every package on load.
- A fatal manifest violation rejects only that plugin. Failures inside one plugin never affect the others.
- Packages are plain vault files. You can version them, export them with your vault, and read them on any device. They need no Node runtime, so the same packages work on desktop and mobile.
