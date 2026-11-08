# Roadmap

Active direction only. Open work, acceptance, and evidence live in GitHub Issues.
The detailed pre-2026-11-07 backlog is in
[roadmap-archive-2026-11.md](docs/development/roadmap-archive-2026-11.md).

## Now

**Simplify the interaction surface.** Cut duplicate controls before adding new
surfaces.

- Remove the todo tracker.
- Remove plan mode.
- Remove `/config`, `/mode`, the `/project` tombstone, and all aliases.
- Reduce visible settings to three tabs: Models, Agent, Advanced.

## Next

**Safety and durability**
- #152 — atomic session rewrite for compaction and rewind.
- #150 — max-turns cap.

**Trusted change loop**
- Keep issues as the durable queue and `ROADMAP.md` as direction.
- Add deterministic pre-review, patch-id verdicts, and a merge-regret ledger when
  the cut lands. See [factory-notes.md](docs/development/factory-notes.md).

**Exploratory QA**
- `@break-change` agent skill: seeded vault, model-driven edge cases, removal
  audits, and a findings report.

## Later

- UI evidence clips: approval Stop, session-switch queued prompt, semantic crash
  repair, plugin install recovery.
- Live MCP e2e with Context7.
- Honest context readout (#248).
- Inline-image retry context fix.
- Subsystem review: semantic index, memory, observability, output styles.
- Product shape discussion after the cut.

## Not doing

- Memory v2 (#143, #145).
- Plan redesign (#149).
- Recall-compaction.
