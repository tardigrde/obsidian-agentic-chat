# Install

Agentic Chat runs on Obsidian desktop and mobile. It is not desktop-only.

Two things get installed at different times:

- **The plugin itself** (this guide, up to "Manual install").
- **Agent plugins** — skill/MCP packages you bring into the vault (below).

## From Obsidian community plugins

1. Open Obsidian settings.
2. Go to **Community plugins** and disable restricted mode if Obsidian asks.
3. Choose **Browse** and search for **Agentic Chat**.
4. Install and enable the plugin.

This is the recommended path for normal use because Obsidian handles updates through the community plugin directory.

## Via BRAT

Use [BRAT](https://github.com/TfTHacker/obsidian42-brat) when you want pre-release builds before they reach the community directory.

1. Install and enable BRAT.
2. Add `tardigrde/obsidian-agentic-chat` as a beta plugin.
3. Let BRAT install or update the plugin from GitHub releases.

## Manual install

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest GitHub release.
2. Copy them into `<your vault>/.obsidian/plugins/agentic-chat/`.
3. Reload Obsidian.
4. Enable **Agentic Chat** under **Settings > Community plugins**.

## Installing agent plugins

Agent plugins are packages (a `plugin.json`, optional `skills/`, optional `mcp.json`) that live inside your vault as plain files — no Node runtime, no build step. See [Agent Plugins](../features/agent-plugins.md).

Open **Settings → Resources** and use **Install plugin…**. You can import from any of:

- a **GitHub URL** — repo shorthand (`owner/repo`), `github.com/owner/repo` tree, blob, or raw URLs, or a direct `.zip` / `.tar.gz` / `.tgz` archive URL (for example a release asset or `codeload` tarball);
- a **.zip / .tar.gz** archive file from disk;
- a **vault folder** (desktop only) containing an agent plugin package, a Claude Code / Codex / Copilot plugin, or a marketplace catalog.

Claude (`plugin.json` + `.claude-plugin/`), Copilot (`.codex-plugin/`), and VS Code (`.plugin/`) packages are converted automatically to the Agent Plugins 1.0 format: skills are copied whole, `mcpServers` become an `mcp.json`, and unsupported fields (stdio transports, `headersHelper`, `displayName`, …) are dropped with warnings you can see in the install summary. Imported MCP servers are **disabled by default** — enable them on the MCP tab after checking their endpoints.

Installing over an existing plugin with the same name replaces it in place (your edits to its `mcp.json` are preserved by MCP server id).

Use **New skill…** on the same tab to scaffold a single-skill package, **Remove** on a plugin row to delete a package and its MCP servers, and **Repair built-ins** to recreate the bundled `builtins` package if it was deleted.

See also [`/install-plugin` chat support](../features/agent-plugins.md) — Agentic Chat can walk you through fetching and authoring a package.
