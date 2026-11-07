# 0003 — Remove plan mode

- Status: Accepted
- Date: 2026-11-07
- Issue: #149

## Decision

Remove plan mode, the sticky plan state, the Plan badge, and the
`PLAN_COMPLETE` marker. Do not add a new read-only toggle in this round.

## Why

- The mode is unused by the owner.
- The prompt says “No tool calls are allowed” while the gate allows 16 read
  tools. The mode contradicts itself.
- The open plan-redesign PR adds about 1,700 lines and a new plan artifact
  subsystem while the product is being cut.
- Safe/YOLO already separates the two postures users need today.

## Consequences

- Remove `/plan` and the plan exit surfaces.
- Keep the Safe/YOLO distinction.
- Revisit a small read-only lock later only if the owner misses it.
- Close #149. Do not salvage the plan artifact work.

## Links

- #149
- `src/agent/modes.ts`
