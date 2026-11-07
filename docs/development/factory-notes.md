# Factory notes

Status: notes only. No factory scripts are being built in the 2026-11-07
simplification round. This page records the model so it is not lost.

## Purpose

“Trust the change” is a better frame than “software factory.” The goal is a
repeatable loop with high-quality validation, not maximum throughput.

Sources:

- pstack: witness-first units, an independent verifier, bottom-up merge, one
  retry.
- [addyosmani/factory](https://github.com/addyosmani/factory): charter, GitHub
  Issues as a queue, fresh verifier, gate verdict, back-pressure, human merge.

## Loop

```text
signal -> issue -> triage -> roadmap Now/Next -> worktree + PR
       -> witness + evidence -> independent verdict -> merge
       -> close issue + update roadmap -> weekly review
       -> regression? new signal
```

## Adopt later

- A human-owned charter with tiers A/B/C, protected paths, stop conditions, and
  a cap on open PRs.
- A contract for issue labels, handoff comments, and evidence.
- Deterministic pre-review: PR body/head match, witness counts, UI evidence,
  feature-map refs, size, secrets.
- Patch-id verdicts so a rebase with the same diff does not need a new verdict.
- A merge-regret ledger: merged PRs joined to reverts and `fix:` commits within
  14 days.
- A bug issue form with version, platform, provider/model, `/doctor`, and a
  redacted JSONL.
- A weekly ops review: open PR age, verdict latency, releases per week, regrets,
  feature-map `NONE` count.

## Do not adopt

- Autonomous workstreams that pick their own signals.
- Automerge.
- Multi-model routing panels.
- A web preview service for an Obsidian plugin.
- Spec-first standardization of every change.

## Where it lives

- Durable work: GitHub Issues.
- Direction: `ROADMAP.md`.
- Decisions: `docs/adr/`.
- Current day: `logs/remaining-plan.md`, ephemeral.
- Evidence: PR/issue links.

The next step is not another process surface. It is the interaction cut. Revisit
this page after the cut.
