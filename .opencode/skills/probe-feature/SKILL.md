---
name: Probe Feature
description: Use when a feature's correct behavior is unknown, or when you need a recorded before/after from the real Obsidian app. Runs a throwaway probe, writes a report, and promotes proven behavior into deterministic e2e specs.
metadata:
  opencode/autoinvoke: false
---

# Probe feature

A probe is an experiment, not a test. It answers "what actually happens?" with a
recording a human can watch and metrics an agent can check. It does not enter CI.

## Before the first run

Write one falsifier:

> Keep it if `<observable>`. Kill it if `<observable>`.

If you cannot name an observable, the idea is not ready. Park it.

One hypothesis per run. Maximum three runs. After that, report what you learned and
stop. A probe that keeps running is a feature in disguise.

## Protocol

1. Pick a scenario from `test/e2e/probe/scenarios/` or add one.
2. Start from a generated vault. Never use `~/MyTestVault` for a probe.
3. Drive a journey, not a screen: open, act, observe, change one thing, observe
   again. The interesting behavior is in the transitions.
4. Mark each decisive moment with `record.mark(label)`.
5. Run:

```bash
npm run probe -- --scenario <name>
npm run probe -- --scenario <name> --live
npm run probe -- --scenario <name> --gif 00:08-00:16
```

6. Read the keyframes and metrics. Answer the falsifier.
7. Write the observations into `report.md`.

## What the runner gives you

```text
logs/probes/<timestamp>-<scenario>/
  session.mp4     whole display, isolated Xvfb, settings popouts in frame
  key.gif         optional excerpt
  timeline.json   every mark with its timestamp
  metrics.json    viewport, overflow, rects, counts
  shots/*.png     one keyframe per mark
  report.md       stub with timeline and result
```

The human watches the video. The agent reads the keyframes and metrics. State
`mode: live` or `mode: scripted` in the report; never present scripted turns as a
real model.

## Scenario shape

```ts
import { describe, it } from "mocha";
import { mark, clickWithRipple, writeMetrics } from "../support/record";

describe("probe: my journey", function () {
  this.timeout(180_000);

  it("records the before and after", async function () {
    mark("start");
    // act
    mark("observed failure");
    // change one setting or input
    mark("observed recovery");
    await writeMetrics({ /* what you measured */ });
  });
});
```

Keep the scenario disposable. It is a script for a question, not a permanent test.

## Promote

When the answer is "keep it", extract the durable behavior:

1. Write assertions in `test/e2e/specs/<area>.e2e.ts`.
2. Run three times with no retries.
3. Prove the spec can fail: revert the behavior or add the negative case and watch
   it go red.
4. Delete the probe scenario; keep the report summary in the PR body.
5. Add the entry point to the feature map with the spec path.

When the answer is "kill it", delete the branch. Keep the report. That is a cheap
loss, which is the point.

## Anti-theater rules

- A screenshot is not a verdict. Every claim has a DOM, state, or layout check.
- A recording that always passes is suspicious. Check the observation method before
  the system.
- Do not pixel-diff the video. Timing, model text, and cursor position differ.
- Do not promote a probe into CI. Promote its assertions.
- Do not use a probe to avoid writing a witness for a known behavior.

## Read next

- `@verify-obsidian-chat` for selectors, launch, and evidence rules.
- `@ship-change` for the promotion and done checklist.
