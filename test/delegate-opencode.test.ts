import { describe, expect, it } from "vitest";
import { findingsFor, jobState, render, waitForJob } from "../scripts/delegate-opencode.mjs";

const bot = (over: Record<string, unknown> = {}) => ({
  login: "github-actions[bot]",
  commit_id: "head1",
  path: "src/a.ts",
  line: 7,
  original_line: 7,
  body: "A finding.\nSecond line.",
  ...over,
});

describe("OpenCode job state", () => {
  it("maps each check bucket to one state", () => {
    const state = (bucket: string) => jobState([{ name: "opencode-review", bucket }]);
    expect(state("pass")).toBe("pass");
    expect(state("fail")).toBe("failed");
    expect(state("cancel")).toBe("failed");
    expect(state("skipping")).toBe("skipped");
    expect(state("pending")).toBe("pending");
  });

  it("tells a missing job from an unreadable status", () => {
    expect(jobState([{ name: "ci", bucket: "pass" }])).toBe("missing");
    expect(jobState(null)).toBe("unknown");
  });

  it("matches a workflow-prefixed check name", () => {
    expect(jobState([{ name: "OpenCode review / opencode-review", bucket: "pass" }])).toBe("pass");
  });
});

describe("OpenCode findings", () => {
  it("keeps only bot comments made on this head, on one line each", () => {
    const found = findingsFor(
      [bot(), bot({ commit_id: "old" }), bot({ login: "tardigrde" }), bot({ line: null, original_line: 3, path: "b.ts", body: "x" })],
      "head1",
    );
    expect(found).toEqual(["- src/a.ts:7 A finding. Second line.", "- b.ts:3 x"]);
  });

  it("says 'no findings' only when the job passed", () => {
    expect(render("pass", [])).toContain("No findings");
    for (const state of ["failed", "skipped", "pending", "missing", "unknown"]) {
      const text = render(state, [], 30);
      expect(text.split("\n")[0]).toBe(`OpenCode job: ${state}`);
      expect(text).not.toContain("No findings");
    }
    expect(render("failed", [])).toContain("NOT read");
    expect(render("pending", [], 30)).toContain("30s");
  });

  it("lists the findings under a passing job", () => {
    expect(render("pass", ["- a.ts:1 x"])).toBe("OpenCode job: pass\n- a.ts:1 x\n");
  });
});

describe("waiting for the job", () => {
  const checks = (...buckets: string[]) => {
    let call = 0;
    return () => [{ name: "opencode-review", bucket: buckets[Math.min(call++, buckets.length - 1)] }];
  };
  const options = (extra = {}) => ({ waitSeconds: 100, intervalSeconds: 20, sleep: async () => {}, ...extra });

  it("returns at once when the job has settled", async () => {
    expect(await waitForJob(checks("pass"), options())).toEqual({ state: "pass", waited: 0 });
  });

  it("polls a pending job until it passes", async () => {
    expect(await waitForJob(checks("pending", "pending", "pass"), options())).toEqual({ state: "pass", waited: 40 });
  });

  it("stops at the wait budget and reports pending", async () => {
    expect(await waitForJob(checks("pending"), options())).toEqual({ state: "pending", waited: 100 });
  });

  it("gives a missing job only a short grace period", async () => {
    const result = await waitForJob(() => [{ name: "ci", bucket: "pass" }], options({ waitSeconds: 600 }));
    expect(result.state).toBe("missing");
    expect(result.waited).toBe(60);
  });

  it("does not wait on an unreadable status", async () => {
    expect(await waitForJob(() => null, options())).toEqual({ state: "unknown", waited: 0 });
  });
});
