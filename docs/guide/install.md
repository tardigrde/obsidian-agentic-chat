# Install

Agentic Chat runs on Obsidian desktop and mobile.

Two things get installed at different times:

- **The plugin itself.** This guide covers it up to "Manual install".
- **Agent plugins.** These are skill and MCP packages you bring into the vault (see below).

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

Agent plugins are packages (a `plugin.json`, optional `skills/`, optional `mcp.json`) that live inside your vault as plain files. They need no Node runtime and no build step. See [Agent plugins](../features/agent-plugins.md).

Open **Settings > Agentic Chat > Resources** and use **Install plugin…**. You can import from any of:

- a **GitHub URL**: repo shorthand (`owner/repo`), `github.com/owner/repo` tree, blob, or raw URLs, or a direct `.zip`, `.tar.gz`, or `.tgz` archive URL (for example a release asset or `codeload` tarball);
- a **.zip, .tar.gz, or .tgz** archive file from disk;
- a **vault folder** (desktop only) that contains an agent plugin package, a Claude Code, Codex, or Copilot plugin, or a marketplace catalog.

The importer converts Claude (`.claude-plugin/`), Codex (`.codex-plugin/`), and Copilot or VS Code (`plugin.json` and `.plugin/`) packages to the Agent Plugins 1.0 format. It copies skills whole, converts `mcpServers` to `mcp.json`, and drops unsupported fields (stdio transports, `headersHelper`, `displayName`, and others) with warnings in the install summary. Imported MCP servers are **disabled by default**. Enable them in the Advanced tab under MCP tools after you check their endpoints.

Installing over an existing plugin with the same name replaces it in place. Your edits to its `mcp.json` are preserved by MCP server id.

Use **New skill…** on the same tab to create a single-skill package. Use **Remove** on a plugin row to delete a package and its MCP servers. Use **Repair built-ins** to recreate the bundled `builtins` package if it was deleted.

See also the `install-plugin` skill. Run `/skill install-plugin` (or `/install-plugin`) in chat, and Agentic Chat will walk you through fetching and authoring a package.
