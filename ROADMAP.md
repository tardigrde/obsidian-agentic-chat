# Roadmap

Active direction only. Open work, acceptance, and evidence live in GitHub Issues
and PRs. The detailed pre-2026-11-07 backlog is in
[roadmap-archive-2026-11.md](docs/development/roadmap-archive-2026-11.md).

## Now

**Architecture refactor.** The code works, but its structure makes every change
expensive. Run the highest-leverage refactors first, without dropping a feature:

- one conversation core instead of the callback-wired `Agent*Runtime` web;
- split `src/ui/chat-view.ts`, `src/settings.ts`, `src/tools/vault-tools.ts`,
  and `src/mcp/oauth.ts` by concern;
- one vault file system port with one atomic write;
- one session repository; one context and token accounting module.

Each refactor PR is behavior-preserving and runs the full e2e lane. A refactor
batch ends with live dogfood, evals, and a chaos pass.

**Test architecture.** Make it obvious which check to run, when, and with which
settings. Group the lanes by purpose, drop checks that prove nothing, and put
the guide into the agent skills.

## Next

- **Feature map complete.** Every user entry point is in the map, a check proves
  the inventory, and `NONE` rows move to `covered`.
- **Release the interaction cut** (#289) after the user approves. Release
  automation is paused.
- **Open bugs:** #315 (permission mode dropdown), #316 (Retry sends twice after
  a tool turn), #317 (bot comment cancels the review gate).
- **Trusted change loop:** deterministic pre-review, patch-id verdicts, and a
  merge-regret ledger. See [factory-notes.md](docs/development/factory-notes.md).
- **Product shape:** discuss it now that the cut has landed.

## Later

- Nightly lane: full e2e, mobile, dry chaos, and mutation (#307, #290).
- UI evidence clips: approval Stop, session-switch queued prompt, semantic crash
  repair, plugin install recovery.
- Live MCP e2e with Context7 in the regular lane.
- Drop the `glob` override in `package.json` when mocha accepts glob 14.

## Not doing

- Memory v2 (#143, #145).
- Plan redesign (#149).
- Recall-compaction.
