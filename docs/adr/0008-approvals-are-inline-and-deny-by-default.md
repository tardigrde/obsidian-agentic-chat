# 0008 — Approvals are inline, deny-by-default, and never silently remembered for skill writes

- Status: Accepted
- Date: 2026-11-22
- Supersedes: the modal approval flow removed in #409

## Decision

Approval is a transcript event, not a modal. The approval card renders inside
the turn it belongs to. On settle, the card is removed and the durable record is
the activity-line step row (or a one-line card when the turn has no step row).
Stopping, aborting, or closing the tab settles a pending card as stopped.

One resolver owns every approval ladder:

- Safe mode honours the configured policy; YOLO turns the mutating default into
  `allow`, but an explicit per-tool `deny` still wins.
- A recursive folder delete always asks unless that tool has an explicit
  per-tool `allow`. Bulk destruction needs a plain per-path confirmation.
- `create_skill` defaults to `ask`. A remembered allow is never written for it:
  one fatigued "don't ask again" would disarm the injection gate for every
  future skill write. Deny may be remembered; allow may not.
- Ignored/private paths are denied before an approval card is shown and before
  an undo checkpoint is captured. Approval cannot make a private path public.
- A delete moves the file to the vault trash so the user can recover it. A
  destructive batch still goes through the gate even under a blanket allow.

## Why

A modal blocks the composer and the Stop button, which is the wrong shape for a
long agent run that can ask several times. An inline card keeps the question
attached to the tool call, and the step row keeps the answer after the card is
gone. String-matching a modal's disappearance cannot prove which choice was
recorded; a step row can.

The gates are layered because the failure modes differ. Safe/YOLO is a posture,
per-tool approval is a standing consent, and a recursive delete is a one-off
destructive action. Collapsing them into one switch lets a global setting
approve an action the user never saw.

Remembering a skill allow is the one exception because the consequence outlives
the session: the skill package is read by every later turn, so a poisoned
`fetch_url -> create_skill evil` path must not become permanent because of one
click.

## Consequences

- Approval UI lives in `src/ui/approval-card.ts`; there is no approval modal.
- `resolveToolPolicy` is the single ladder. New tool families add a query type,
  not a parallel resolver.
- Tests assert the recorded choice, not the presence of a modal.
- The subagent `ask` dispatch is still auto-approved while its child tools are
  gated; that open safety question is tracked in the cleanup hack list, not
  blessed by this ADR.

## Links

- `src/agent/approval-policy.ts`
- `src/agent/approval-memory.ts`
- `src/agent/tool-call-controller.ts`
- `src/ui/approval-card.ts`
- `test/e2e/specs/multi-tab-approval.e2e.ts`
- `test/e2e/specs/session-delete-tabs.e2e.ts`
