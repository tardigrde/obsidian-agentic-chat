import { describe, expect, it } from "vitest";
import { failedCount, runningLabel, stepRowParts, summarizeSteps, type SummaryStep } from "../src/ui/activity-summary";

const step = (name: string, args: Record<string, unknown> = {}, status: SummaryStep["status"] = "done"): SummaryStep => ({
  name,
  rawArgs: JSON.stringify(args),
  status,
});

describe("activity line summary", () => {
  it("groups verbs in the order they first happen and merges counts", () => {
    expect(
      summarizeSteps([
        step("vault_inspect", { action: "search", query: "meeting" }),
        step("read", { path: "A.md" }),
        step("read", { path: "B.md" }),
        step("edit", { path: "Plan.md" }),
        step("read", { path: "C.md" }),
        step("read", { path: "D.md" }),
      ]),
    ).toBe("Searched vault, read 4 notes, edited 1");
  });

  it("leaves failed steps out of the verbs and counts them apart", () => {
    const steps = [
      step("vault_inspect", { action: "search" }),
      step("read", { path: "A.md" }),
      step("read", { path: "B.md" }),
      step("read", { path: "C.md" }),
      step("fetch_url", { url: "https://vendors.example.com/pricing" }, "error"),
    ];
    expect(summarizeSteps(steps)).toBe("Searched vault, read 3 notes");
    expect(failedCount(steps)).toBe(1);
  });

  it("names MCP servers and subagents, and uses the singular for one", () => {
    expect(summarizeSteps([step("mcp__notion__search"), step("mcp__notion__fetch"), step("subagent"), step("read", { path: "a" })])).toBe(
      "Used notion ×2, ran 1 subagent, read 1 note",
    );
    expect(summarizeSteps([step("read", { path: "a" }, "running")])).toBe("");
  });

  it("says what a running step does", () => {
    expect(runningLabel("read", JSON.stringify({ path: "Meetings/Kickoff.md" }))).toBe("Reading Meetings/Kickoff.md");
    expect(runningLabel("fetch_url", JSON.stringify({ url: "https://vendors.example.com/pricing" }))).toBe("Fetching vendors.example.com");
    expect(runningLabel("vault_inspect", JSON.stringify({ action: "search" }))).toBe("Searching the vault…");
    expect(runningLabel("mcp__github__issues", "{}")).toBe("Using github…");
  });

  it("splits a compact row into a short verb, the argument, and a clickable vault path", () => {
    expect(stepRowParts("read", JSON.stringify({ path: "Meetings/Sync.md" }))).toEqual({ verb: "Read", arg: "Meetings/Sync.md", path: "Meetings/Sync.md" });
    expect(stepRowParts("vault_inspect", JSON.stringify({ action: "search", query: "tag:#meeting" }))).toEqual({ verb: "Search", arg: "tag:#meeting", path: "" });
    expect(stepRowParts("fetch_url", JSON.stringify({ url: "https://x.example/p" }))).toEqual({ verb: "Fetch", arg: "https://x.example/p", path: "" });
  });
});
