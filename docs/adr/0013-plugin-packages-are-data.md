# 0013 — Plugin packages are data; their MCP servers are runtime copies that start disabled

- Status: Accepted
- Date: 2026-11-22
- Issue: #409 and the plugin import work

## Decision

A plugin package in the vault is data. `plugin.json` and `mcp.json` describe its
shape; client-owned state (enabled, approval, auth, known tools, OAuth) lives in
`settings.plugins.mcpState`, keyed by a stable server id. The runtime builds a
copy on load. It never writes client state back into the package.

Plugin-declared MCP servers start disabled. Importing a package does not enable
them, and a hand-authored `mcp.json` appearing on disk does not either. Only the
explicit "Add MCP server" generator opts a server in.

Every endpoint change resets client-owned state: tokens, static credentials,
discovered tools, and pending OAuth challenges were minted for the old host and
must not follow the URL.

Installs are crash-safe:

- Stage the package under `.importing-<name>-<ts>`, write `plugin.json` last,
  then rename into place.
- Serialize install transactions with the recovery sweep; a sweep must not
  delete a stage an install is using.
- Sweep leftover stages at startup and restore a backup only when the target is
  missing.
- Reject paths that escape the plugins folder, Windows reserved device names,
  and traversal segments.
- Sanitize imported frontmatter to the Agent Skills allowlist and resolve
  `${CLAUDE_PLUGIN_ROOT}`-style placeholders at install time.

## Why

Writing runtime state into a package makes an upgrade destructive: the next
install overwrites the user's enable/approval choices, and a package sync
carries vault-specific secrets to another machine. Keeping the shape immutable
and the state separate makes every package replaceable.

Starting disabled is the safe default for imported code. A package that arrives
with an MCP server should not gain network access and tool authority because the
user imported a skill.

A partial install can leave a half-written package. Staging plus a final rename
means the loader sees either the old package or the new one, never a mix. The
sweep is the only writer allowed to clean the stage area, and it runs under the
same lock as installs.

## Consequences

- `src/plugins/loader.ts` derives the stable id and validates the package.
- `src/plugins/service.ts` owns the install lock, staging, and sweep.
- `src/agent/runtime-resources.ts` merges package shape with client state; it
  does not persist the merged copy.
- `src/mcp/server-state.ts` resets state on an endpoint change.
- Import tests cover foreign layouts, reserved names, and placeholder
  resolution; a new layout adds a converter, not a loader special case.

## Links

- `src/plugins/loader.ts`
- `src/plugins/service.ts`
- `src/plugins/import/`
- `src/agent/runtime-resources.ts`
- `src/mcp/server-state.ts`
- `test/plugins-service-prune.test.ts`
- `test/plugins-import.test.ts`
