# 0008 — Approvals are inline, deny-by-default, and never silently remembered for skill writes

- Status: Accepted
- Date: 2026-11-22
- Supersedes: the modal approval flow removed in #409

## Decision

Approval is an inline card in its own turn, not a modal; once it settles, the activity-line step row is
the durable record. Stop, abort, or a closed tab settles a pending card as stopped.

One resolver owns every ladder: YOLO turns a mutating default into `allow`, but an explicit per-tool
`deny` wins. `create_skill` always asks and never remembers an allow. A private path is denied before a
card or a checkpoint.

## Why

A modal blocks the composer and Stop, and its disappearance cannot prove which choice was recorded. A
layered gate keeps a global setting from approving what the user never saw, and a remembered skill allow
would outlive the session and disarm the injection gate.

## Consequences

- `src/agent/approval-policy.ts` stays the single ladder; a new tool family adds a query type.
- Keep the UI inline and the private-path deny ahead of the card and checkpoint. Tests assert the choice.
- The subagent `ask` auto-approval stays an open hack-list question, not a rule here.

## Links

- `src/agent/approval-policy.ts`
- `src/agent/approval-memory.ts`
- `test/e2e/specs/multi-tab-approval.e2e.ts`
