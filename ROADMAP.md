# Roadmap

Active direction only. Open work, acceptance, and evidence live in GitHub Issues.
The detailed pre-2026-11-07 backlog is in
[roadmap-archive-2026-11.md](docs/development/roadmap-archive-2026-11.md).

## Now

**Ship the interaction cut.** The surface is cut and merged; the remaining work
is verification and the release decision.

- Run the live chaos pass on the merged cut. Done 2026-11-08; all hostile
  targets passed.
- Release the cut only after the user approves. Release automation is paused.

## Next

**Trusted change loop**
- Keep issues as the durable queue and `ROADMAP.md` as direction.
- Add deterministic pre-review, patch-id verdicts, and a merge-regret ledger.
  See [factory-notes.md](docs/development/factory-notes.md).

**Dependency hygiene**
- Bump the top-level `obsidian-launcher` to match the `3.5.0` service.
- Triage the pre-existing moderate audit findings and unapproved install
  scripts.

**Product shape**
- Discuss the product shape now that the cut has landed.

## Later

- UI evidence clips: approval Stop, session-switch queued prompt, semantic crash
  repair, plugin install recovery.
- Live MCP e2e with Context7 in the regular lane.
- Subsystem review: semantic index, memory, observability, output styles.

## Not doing

- Memory v2 (#143, #145).
- Plan redesign (#149).
- Recall-compaction.
