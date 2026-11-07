---
name: Break Change
description: Use before a product-cut PR or after a removal to run 5-10 adversarial exploratory QA scenarios in a throwaway Obsidian vault, prove a deleted entrypoint is gone, and write a PASS/FINDINGS/INCONCLUSIVE report. Not a deterministic gate and not a replacement for /doctor, e2e, or the witness.
metadata:
  opencode/autoinvoke: false
---

# Break change

Try to break the change before a user does. Pick a small set of risky scenarios,
drive the real Obsidian app on a throwaway vault, and leave a report that a human
can audit. This is exploratory evidence. It is not a gate, not deterministic
proof, and not a replacement for `/doctor`, e2e, or the witness.

## Inputs

- A PR, branch, commit range, or work item.
- The changed entrypoints and the matching feature-map rows.
- The lowest deterministic lane that already passes. If the change has no
  witness or no e2e proof, say so in the report; do not hide it with exploration.

## Modes

| mode | use for |
|---|---|
| `targeted` | The default. Attack the changed behavior and its nearest neighbors. |
| `removal` | A command, setting, modal, route, or UI entrypoint was deleted. Prove it is gone and the neighbors still work. |
| `general` | No specific change. Scan the feature map for `partial` and `NONE` rows and target 1-3 high-risk gaps. |

## Hard rules

1. **Throwaway vault only.** The e2e lane copies `test/e2e/vault` into a sandbox
   and loads the local plugin. Never point the harness at `~/MyTestVault` or any
   real vault. Never use destructive tools on user notes.
2. **No secrets.** Do not put an API key, bearer token, or real vault data in a
   report, event, screenshot, or clip. Live mode reads the key from the local
   environment; never print it.
3. **Cap the run.** 5-10 scenarios, at most 3 per surface, one attempt each. Stop
   after three failures with the same cause. The e2e wrapper has a 15 minute
   default timeout.
4. **No live model by default.** Scripted turns use the `__AGENTIC_CHAT_E2E_TURNS__`
   hook. A live run needs explicit user consent plus:
   `BREAK_CHANGE_LIVE=1 BREAK_CHANGE_MAX_LIVE_TURNS=1..3`. The template refuses a
   live run without that cap.
5. **Label the evidence.** State `scripted` or `live` in the report. A scripted
   reply is never presented as a real model answer.
6. **Clean up.** The wrapper removes the generated spec after the run, including
   on failure and interruption. The e2e service removes its sandbox vault. Run a
   final `cleanup` before you finish.

## Procedure

### 1. Start the run

```bash
node .agents/skills/break-change/scripts/break-change.mjs init \
  --work-item "PR #123: remove /endplan" \
  --mode removal \
  --pr 123
```

This writes `logs/break-change/<timestamp>/`:

```text
report.md          report skeleton
run.json           mode, head, base, status, cleanup
events.jsonl       append-only evidence events
change.json        diff stat, files, recent commits
pr.json            PR body and files, when --pr is used
clips/             UI evidence output
artifacts/         scratch space
```

It also generates `test/e2e/specs/break-change.<timestamp>.e2e.ts` from
`templates/scenario.e2e.ts`. The generated spec is local and disposable.

### 2. Read the change

Read the PR body, `change.json`, and the matching feature-map journey. Name the
changed entrypoints before you write a scenario. For a removal, list every
surface that could still expose the old path.

### 3. Choose 5-10 scenarios

Attack the change, not the whole product. Use this table to spread the risk:

| category | example |
|---|---|
| primary path | The changed command, setting, modal, or tool still does the new thing. |
| removal | The old entrypoint is absent from `/help`, the registry, UI, docs, the slash-command table, the feature map, imports, and routes. |
| adjacent behavior | The command next to the removed one still works. |
| empty or invalid input | Missing argument, empty prompt, unknown command, malformed setting. |
| permission gate | Safe/YOLO/Plan or allow/deny still gates the changed path. |
| state and reload | Close, reopen, switch tab, reload the plugin, and check persistence. |
| race or interruption | Stop mid-turn, double-click, switch tabs while an approval is open. |
| docs and UI drift | Visible text, help, docs, and the feature map agree with the code. |

Write one `Scenario` per risk in the generated spec. Each scenario has an `id`
(`S1`...), a severity (`S1` blocker to `S4` low), an `expected` sentence, and a
`run` function. Keep the default self-check scenarios only when they are relevant;
replace them with the real risks.

### 4. Run the scenarios

```bash
node .agents/skills/break-change/scripts/break-change.mjs run \
  --run logs/break-change/<timestamp>
```

The wrapper:

- runs `npm run verify -- e2e <generated-spec>`;
- writes `run.log`, parses the test counts, and copies new
  `logs/e2e-artifacts/` directories into the run;
- snapshots the spec to `spec.snapshot.e2e.ts`;
- removes the generated spec on success, failure, and `SIGINT`/`SIGTERM`.

A non-zero exit is normal when a scenario finds a real problem. Read the counts:
zero tests or every test skipped is a failure, not a pass. If you need another
attempt, restore the snapshot:

```bash
node .agents/skills/break-change/scripts/break-change.mjs spec \
  --run logs/break-change/<timestamp>
```

Then edit, run, and clean up again. Do not exceed three attempts for one cause.

### 5. Removal audit

For a deleted command, setting, route, or UI entrypoint, search every surface:

```bash
node .agents/skills/break-change/scripts/break-change.mjs audit \
  --run logs/break-change/<timestamp> \
  --term endplan \
  --term /endplan
```

The helper writes `audit.json` with these surfaces:

- command registry (`src/ui/commands.ts`)
- `/help` and the composer (`src/ui/chat-view.ts`)
- UI and settings (`src/ui/`, `src/settings.ts`)
- docs (`README.md`, `docs/`, changelog, mobile notes)
- slash-command table (`.agents/skills/verify-obsidian-chat/features/commands-and-skills.md`)
- feature map (`.agents/skills/verify-obsidian-chat/features/`)
- imports and routes (`src/`, `src/main.ts`, `src/plugin.ts`, `manifest.json`)
- tests and scripts

`ABSENT` means no hit. `PRESENT` is not automatically a failure: a removal note
in docs or a negative test is legitimate. Inspect every hit and explain it in the
report. Then prove the nearest surviving behavior still works with a scenario in
the same run.

A good removal report answers all of these:

- `/help` does not list it.
- The registry does not resolve it.
- The UI has no control or route for it.
- Docs and the slash-command table do not tell users to use it.
- The feature map has no live row for it.
- No import or route still wires it.
- The adjacent command or setting still works.

### 6. General scan

When there is no specific work item, scan the feature map:

```bash
node .agents/skills/break-change/scripts/break-change.mjs scan \
  --run logs/break-change/<timestamp> \
  --limit 10
```

`scan.json` lists `partial` and `NONE` rows with a risk score. Pick 1-3 high-risk
rows. Do not try to cover the whole map in one run; one good repro is worth more
than ten shallow checks.

### 7. UI evidence

When the change is user-visible, record both viewports. Use the probe harness so
the whole display is in frame, including settings popouts:

```bash
npm run probe -- --scenario test/e2e/probe/scenarios/layout-smoke.e2e.ts \
  --size 1280x1024 \
  --out logs/break-change/<timestamp>/clips/desktop-1280x1024

npm run probe -- --scenario test/e2e/probe/scenarios/layout-smoke.e2e.ts \
  --size 390x844 \
  --out logs/break-change/<timestamp>/clips/mobile-390x844
```

Use a scenario that drives the changed journey, or add a disposable probe
scenario with `record.mark()` at each decisive moment. In the report, name the
timestamps and mark labels a reviewer should watch. If clips are not possible,
write the waiver reason in `## UI evidence`; the PR template requires it.

### 8. Write the report

Fill `report.md` with:

- severity per scenario and per finding (`S1` blocker, `S2` high, `S3` medium,
  `S4` low);
- exact repro (command, steps, fixture path);
- expected and actual behavior;
- evidence paths (`run.log`, `events.jsonl`, `e2e-artifacts/`, `audit.json`,
  `scan.json`, clips);
- a clear `Verdict: PASS`, `Verdict: FINDINGS`, or `Verdict: INCONCLUSIVE`;
- limitations and cleanup state.

Do not paste secrets, tokens, real vault paths, or private note bodies. The
e2e failure artifacts are redacted by the harness, but review them before you
share them.

### 9. Validate and clean up

```bash
node .agents/skills/break-change/scripts/break-change.mjs report \
  --run logs/break-change/<timestamp>

node .agents/skills/break-change/scripts/break-change.mjs cleanup \
  --run logs/break-change/<timestamp>
```

`report` checks the required sections, the 5-10 scenario count, the verdict, the
finding rows, and common secret patterns. `cleanup` removes the generated spec
and any run-local vault. It keeps the report and evidence.

The PR body needs:

```text
## Break-change
- Report: logs/break-change/<timestamp>/report.md
- Verdict: PASS | FINDINGS | INCONCLUSIVE
```

If the change is trivial or not behavior-bearing, write a one-line waiver in the
PR instead.

## Verdicts

| verdict | meaning |
|---|---|
| `PASS` | Every chosen scenario passed; no finding. State what was not covered. |
| `FINDINGS` | At least one reproducible issue. Every finding has severity, repro, expected, actual, and evidence. |
| `INCONCLUSIVE` | The run could not prove the behavior: skipped tests, missing credentials, flaky harness, or a scenario that did not reach the assertion. |

## Promotion

A break-change finding is a lead, not a regression guard. Promote it:

| finding | promote to |
|---|---|
| Reproducible product bug | a failing deterministic unit, replay, or e2e test, then fix it |
| Missing removal proof | a committed e2e assertion plus a feature-map row change |
| Stale docs or help | a docs/help fix and a check that would catch it |
| Flaky or ambiguous observation | fix the observation or fixture; never add a retry |

A break-change report does not upgrade a `partial` or `NONE` feature-map row.
Only a committed user-action check does that.

## Read next

- `@verify-obsidian-chat` for selectors, launch, settings popouts, and evidence.
- `@probe-feature` for a recorded before/after when the behavior is unknown.
- `@ship-change` for the witness and the merge lane.
- `docs/development/verification.md` for the lane reference and the fake-green list.
