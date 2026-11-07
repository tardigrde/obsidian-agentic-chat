# Community plugin review

The Obsidian community plugin review for 0.51.10 reported two warnings and two
behavior recommendations. This page records what changed and why the remaining
recommendations are intentional.

## Lint gap

`npm run lint:obsidian` runs the official `eslint-plugin-obsidianmd` rule set
over `src/`. Before this change the plugin was pinned at 0.4.2 and
`@typescript-eslint/no-deprecated` was off, so the review warnings could not
appear in CI.

The lane now:

- uses `eslint-plugin-obsidianmd` 0.5.1 or later;
- enables `@typescript-eslint/no-deprecated` (with a scoped `display()` allow
  until the declarative settings migration lands);
- runs with `--max-warnings 0`, so a warning fails the lane instead of passing
  silently.

The same command is a step in `npm run verify -- fast` and
`npm run verify -- ci`, so CI carries the gate. There is no API that queries the
community review portal from CI; the gate is the local rule set.

## Removed warnings

- `src/ui/chat-view.ts` checks input events with `event.instanceOf(InputEvent)`
  instead of `instanceof`, so the check works for a popout window.
- `src/ui/new-skill-modal.ts` asks before overwriting an existing package with
  the shared Obsidian `Modal` confirm in `src/ui/confirm-modal.ts`, not the
  native `confirm()`.
- `src/settings.ts` uses `setDestructive()` for the plugin Remove button.
  `manifest.json` now requires Obsidian 1.13.0 because that API needs it.

## Behavior recommendations

The review also notes two behaviors that are not lintable defects. Both are
required product features, so the plugin keeps them deliberately.

### Vault enumeration

The agent tools list, search, and follow notes through Obsidian's vault API
(`app.vault.getFiles()`, `getMarkdownFiles()`, `getAbstractFileByPath()`). That
is the feature: the agent answers questions about the vault and edits notes. The
API is the supported route and keeps reads inside the vault. The ignore list
still filters results before the agent sees them, and file access stays within
the vault adapter. Removing enumeration would remove the product.

### Clipboard access

Settings uses `navigator.clipboard.writeText()` only when the user presses a
Copy control (for example, to copy an MCP server configuration). It is a
user-initiated convenience, not background collection, and the call is guarded
when the clipboard API is unavailable.
