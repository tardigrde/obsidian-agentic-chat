import { describe, expect, it } from "vitest";
import {
  artifactFromDetection,
  buildPlanHandoff,
  detectPlanBody,
  hasPlanCompleteMarker,
  healPlanArtifact,
  manualPlanBody,
  messageHashFor,
  planIdFor,
  PlanMemoryStore,
  planSessionKey,
  stripPlanCompleteMarker,
  teaserLines,
  type PlanArtifact,
} from "../src/agent/plan-artifact";

const HEADING_PLAN = `# Plan: migrate the indexer

- Add batch endpoint (\`src/indexer.ts\`)
- Migrate call sites (\`src/chat-view.ts\`)
- Add tests (\`test/indexer.test.ts\`)`;

describe("PLAN_COMPLETE backward tolerance", () => {
  it("detects the marker and strips it", () => {
    expect(hasPlanCompleteMarker(`${HEADING_PLAN}\nPLAN_COMPLETE`)).toBe(true);
    expect(hasPlanCompleteMarker(HEADING_PLAN)).toBe(false);
    expect(stripPlanCompleteMarker(`${HEADING_PLAN}\nPLAN_COMPLETE`)).toBe(HEADING_PLAN);
  });

  it("accepts a legacy-marked plan with a single bullet", () => {
    const detected = detectPlanBody(`# Quick fix\n\n- Do the thing\nPLAN_COMPLETE`);
    expect(detected?.steps).toHaveLength(1);
    expect(detected?.title).toBe("Quick fix");
  });
});

describe("detectPlanBody", () => {
  it("detects a heading-plus-steps plan", () => {
    const detected = detectPlanBody(HEADING_PLAN);
    expect(detected?.title).toBe("Plan: migrate the indexer");
    expect(detected?.steps).toHaveLength(3);
    expect(detected?.steps[0]).toEqual({ title: "Add batch endpoint (`src/indexer.ts`)", scope: "src/indexer.ts" });
    expect(detected?.scopeFiles).toContain("src/indexer.ts");
  });

  it("detects a fenced <plan> block", () => {
    const detected = detectPlanBody(`Some preamble\n<plan>\n## Deploy\n\n1. Build\n2. Ship\n</plan>\nEpilogue`);
    expect(detected?.title).toBe("Deploy");
    expect(detected?.steps.map((step) => step.title)).toEqual(["Build", "Ship"]);
  });

  it("detects bare numbered steps without a heading", () => {
    const detected = detectPlanBody(`1. Read the note\n2. Draft the summary\n3. Save the result`);
    expect(detected?.steps).toHaveLength(3);
  });

  it("rejects chat text without plan structure", () => {
    expect(detectPlanBody("Looks good, I read the note and it seems fine.")).toBeNull();
    expect(detectPlanBody("- just one bullet, no heading")).toBeNull();
    expect(detectPlanBody("")).toBeNull();
  });
});

describe("artifactFromDetection", () => {
  const detected = detectPlanBody(HEADING_PLAN)!;

  it("creates a v1 artifact with a stable id", () => {
    const artifact = artifactFromDetection(detected, null);
    expect(artifact.revision).toBe(1);
    expect(artifact.status).toBe("pending");
    expect(artifact.id).toBe(planIdFor(detected.title, detected.steps[0].title));
  });

  it("bumps the revision on same-id edits and keeps feedback drafts", () => {
    const first = artifactFromDetection(detected, null);
    const withDraft: PlanArtifact = { ...first, feedbackDraft: "skip the migration" };
    const edited = detectPlanBody(`${HEADING_PLAN}\n- Update docs`)!;
    const second = artifactFromDetection(edited, withDraft);
    expect(second.id).toBe(first.id);
    expect(second.revision).toBe(2);
    expect(second.feedbackDraft).toBe("skip the migration");
    expect(second.steps).toHaveLength(4);
  });

  it("resets to v1 on a new plan id", () => {
    const first = artifactFromDetection(detected, null);
    const other = detectPlanBody(`# Totally different plan\n\n- One\n- Two`)!;
    const second = artifactFromDetection(other, first);
    expect(second.id).not.toBe(first.id);
    expect(second.revision).toBe(1);
  });

  it("resets transient drafts on a new plan id but carries the origin posture", () => {
    const first = artifactFromDetection(detected, null);
    first.originPosture = "yolo";
    const withDraft: PlanArtifact = { ...first, feedbackDraft: "keep me?" };
    const other = detectPlanBody(`# Totally different plan\n\n- One\n- Two`)!;
    const second = artifactFromDetection(other, withDraft);
    expect(second.feedbackDraft).toBeUndefined();
    expect(second.originPosture).toBe("yolo");
  });

  it("carries drafts and posture across same-id revisions", () => {
    const first = artifactFromDetection(detected, null);
    first.originPosture = "safe";
    const withDraft: PlanArtifact = { ...first, feedbackDraft: "skip the migration" };
    const edited = detectPlanBody(`${HEADING_PLAN}\n- Update docs`)!;
    const second = artifactFromDetection(edited, withDraft);
    expect(second.feedbackDraft).toBe("skip the migration");
    expect(second.originPosture).toBe("safe");
  });
});

describe("manualPlanBody", () => {
  it("captures any message as a plan (title + line steps)", () => {
    const body = manualPlanBody("Refactor notes\n\nFirst do this\nThen that");
    expect(body?.title).toBe("Refactor notes");
    expect(body?.steps).toHaveLength(2);
  });

  it("returns null for empty text", () => {
    expect(manualPlanBody("   \n  ")).toBeNull();
  });
});

describe("teaserLines", () => {
  it("skips blank lines instead of stopping at them", () => {
    const artifact = artifactFromDetection(detectPlanBody(`# Plan\n\n- Alpha\n\n- Beta\n- Gamma`)!, null);
    expect(teaserLines(artifact)).toEqual(["Alpha", "Beta", "Gamma"]);
  });
  it("caps the teaser at the heading plus first bullets", () => {
    const artifact = artifactFromDetection(detectPlanBody(HEADING_PLAN)!, null);
    const teaser = teaserLines(artifact);
    expect(teaser).toHaveLength(3);
    expect(teaser[0]).toContain("Add batch endpoint");
  });
});

describe("buildPlanHandoff", () => {
  const artifact = artifactFromDetection(detectPlanBody(HEADING_PLAN)!, null);

  it("sends the artifact (title + steps + scope), not the fixed string", () => {
    const handoff = buildPlanHandoff(artifact);
    expect(handoff).toContain("Plan: migrate the indexer");
    expect(handoff).toContain("1. Add batch endpoint");
    expect(handoff).toContain("Scope: src/indexer.ts");
    expect(handoff).not.toBe("Implement the proposed plan above.");
  });

  it("adds the fresh-thread prefix and context note when requested", () => {
    const handoff = buildPlanHandoff(artifact, { freshThread: true, contextPercent: 89 });
    expect(handoff).toContain("Treat it as the source of intent");
    expect(handoff).toContain("89%");
  });
});

describe("messageHashFor", () => {
  it("is stable and whitespace-insensitive at the edges", () => {
    expect(messageHashFor("  abc  ")).toBe(messageHashFor("abc"));
    expect(messageHashFor("abc")).not.toBe(messageHashFor("abd"));
  });
});

describe("healPlanArtifact", () => {
  const artifact = artifactFromDetection(detectPlanBody(HEADING_PLAN)!, null);

  it("round-trips a persisted artifact", () => {
    expect(healPlanArtifact(JSON.parse(JSON.stringify(artifact)))).toEqual(artifact);
  });

  it("heals adversarial shapes", () => {
    expect(healPlanArtifact({ ...artifact, steps: "nope" })?.steps).toEqual([]);
    expect(healPlanArtifact({ ...artifact, steps: [{ nope: 1 }, { title: "ok" }] })?.steps).toEqual([
      { title: "ok", scope: undefined },
    ]);
    expect(healPlanArtifact({ ...artifact, revision: 0 })?.revision).toBe(1);
    expect(healPlanArtifact({ ...artifact, revision: NaN })?.revision).toBe(1);
    expect(healPlanArtifact({ ...artifact, originPosture: "yolo" })?.originPosture).toBe("yolo");
    expect(healPlanArtifact({ ...artifact, originPosture: "bogus" })?.originPosture).toBeNull();
    expect(healPlanArtifact({ ...artifact, title: `x`.repeat(500) })?.title).toBeTruthy();
  });

  it("rejects unusable shapes", () => {
    expect(healPlanArtifact(null)).toBeNull();
    expect(healPlanArtifact({})).toBeNull();
    expect(healPlanArtifact({ id: "x", title: "y" })).toBeNull();
    expect(healPlanArtifact({ ...artifact, status: "bogus" })?.status).toBe("pending");
  });
});

describe("PlanMemoryStore", () => {
  it("scopes the restore posture per session (no cross-tab leaks)", () => {
    const store = new PlanMemoryStore();
    store.set("path:a.jsonl", "safe");
    store.set("path:b.jsonl", "yolo");
    expect(store.get("path:a.jsonl")).toBe("safe");
    expect(store.get("path:b.jsonl")).toBe("yolo");
    expect(store.get("path:c.jsonl")).toBeNull();
    store.set("path:a.jsonl", null);
    expect(store.get("path:a.jsonl")).toBeNull();
  });
});

describe("planSessionKey", () => {
  it("prefers the stable path, then id, then fallback", () => {
    expect(planSessionKey({ id: "s1", path: "sessions/a.jsonl" }, "tab:0")).toBe("path:sessions/a.jsonl");
    expect(planSessionKey({ id: "s1" }, "tab:0")).toBe("id:s1");
    expect(planSessionKey(undefined, "tab:0")).toBe("tab:0");
  });
});
