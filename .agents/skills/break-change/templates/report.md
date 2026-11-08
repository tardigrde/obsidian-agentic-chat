# Break-change: __BREAK_CHANGE_WORK_ITEM__

- Run: `__BREAK_CHANGE_RUN_ID__`
- Mode: `__BREAK_CHANGE_MODE__`
- Work item: __BREAK_CHANGE_WORK_ITEM__
- Head: `__BREAK_CHANGE_HEAD__`
- Base: `__BREAK_CHANGE_BASE__`
- Started: __BREAK_CHANGE_STARTED_AT__
- Harness: real Obsidian e2e (`npm run verify -- e2e <spec>`), scripted turns by default
- Vault: throwaway `test/e2e/vault` sandbox; never a real vault

## Verdict

Verdict: INCONCLUSIVE

<!-- Use PASS only when every scenario passed and no finding remains.
     FINDINGS means at least one F-id row below.
     INCONCLUSIVE means the run could not prove the behavior. -->

## Scope

- Changed entrypoints:
- Feature-map rows:
- Out of scope:

## Scenarios

| id | severity | scenario | expected | actual | evidence | verdict |
|---|---|---|---|---|---|---|
| S1 | S2 | A scripted chat turn reaches the transcript | The assistant reply renders | <fill> | `run.log`, `events.jsonl` | <PASS/FAIL> |
| S2 | S2 | An absent slash command is not in /help and is not handled locally | Absent from /help; falls through to the model | <fill> | `run.log`, `events.jsonl` | <PASS/FAIL> |
| S3 | S3 | /help still lists adjacent surviving commands | /status and /doctor render | <fill> | `run.log`, `events.jsonl` | <PASS/FAIL> |
| S4 | S2 | A hidden removed command is absent from /help and shows a removal notice | /project is hidden and shows Removed | <fill> | `run.log`, `events.jsonl` | <PASS/FAIL> |
| S5 | S3 | /status still opens the adjacent status panel | Provider and model render | <fill> | `run.log`, `events.jsonl` | <PASS/FAIL> |

## Findings

<!-- If none: "No findings." Keep one F-id row per finding. -->

| id | severity | title | repro | expected | actual | evidence |
|---|---|---|---|---|---|---|
| F1 | S1/S2/S3/S4 | <title> | <command and steps> | <expected> | <actual> | <path> |

## Removal audit

<!-- Required in removal mode. Delete this section in other modes if it is empty. -->

| surface | expected | observed | evidence | verdict |
|---|---|---|---|---|
| `/help` | absent | <observed> | `audit.json` | <PASS/FAIL> |
| command registry | absent | <observed> | `audit.json` | <PASS/FAIL> |
| UI | absent | <observed> | `audit.json` | <PASS/FAIL> |
| docs | absent or historical only | <observed> | `audit.json` | <PASS/FAIL> |
| slash-command table | absent | <observed> | `audit.json` | <PASS/FAIL> |
| feature map | absent | <observed> | `audit.json` | <PASS/FAIL> |
| imports | absent | <observed> | `audit.json` | <PASS/FAIL> |
| routes | absent | <observed> | `audit.json` | <PASS/FAIL> |
| adjacent surviving behavior | works | <observed> | `run.log` | <PASS/FAIL> |

## UI evidence

- Desktop 1280x1024 clip: `clips/desktop-1280x1024/session.mp4` or waiver: <reason>
- Mobile 390x844 clip: `clips/mobile-390x844/session.mp4` or waiver: <reason>
- Watch: <timestamps and mark labels>

## Evidence

- Run log: `run.log`
- Spec snapshot: `spec.snapshot.e2e.ts`
- Scenario events: `events.jsonl`
- Change capture: `change.json`
- E2E diagnostics: `e2e-artifacts/`
- Audit: `audit.json`
- Scan: `scan.json`
- Clips: `clips/`

## Limitations

- Exploratory evidence, not deterministic proof.
- Scripted model turns unless a scenario states `live`.
- Does not replace `/doctor`, e2e, or the witness.
- <add anything the run could not cover>

## Cleanup

- Throwaway vault: removed by the e2e service.
- Generated spec: removed by the wrapper after the run.
- Secrets: none recorded; redact before sharing.
