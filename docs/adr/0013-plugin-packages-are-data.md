# 0013 — Plugin packages are data; their MCP servers are runtime copies that start disabled

- Status: Accepted
- Date: 2026-11-22
- Issue: #409 and the plugin import work

## Decision

Package files are immutable data; client state (enabled, approval, auth, tools, OAuth) lives in
`settings.plugins.mcpState`, keyed by a stable server id, and is never written back. Plugin-declared MCP
servers start disabled: neither an import nor a hand-authored `mcp.json` on disk enables them; only "Add
MCP server" opts one in, and an endpoint change resets every client-owned field.

Installs stage under a temporary name, write `plugin.json` last, then rename into place; install and
recovery sweep share one lock. Reject escaping paths and reserved names, and sanitize imported frontmatter
to the Agent Skills allowlist.

## Why

Writing runtime state into a package makes an upgrade destructive: the next install overwrites the user's
choices, and a package sync carries vault secrets to another machine. Starting disabled is the safe
default, and a partial install cannot half-write the package because the final rename is atomic.

## Consequences

- `src/plugins/loader.ts` derives the stable id and validates the package.
- `src/plugins/service.ts` owns the install lock, staging, and sweep; a new layout adds a converter.
- `src/agent/runtime-resources.ts` merges shape with state and never persists the copy.

## Links

- `src/plugins/loader.ts`
- `src/plugins/service.ts`
- `test/plugins-import.test.ts`
