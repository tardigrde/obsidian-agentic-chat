import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

interface ClassifyInput {
  trackedChanges?: number;
  untrackedChanges?: number;
  prState?: "OPEN" | "MERGED" | "CLOSED" | null;
  merged?: boolean;
  recent?: boolean;
}

interface WorktreeScriptModule {
  classifyWorktree(input: ClassifyInput): string;
}

async function loadWorktreeScript(): Promise<WorktreeScriptModule> {
  return import(pathToFileURL(path.join(process.cwd(), "scripts/worktree.mjs")).href) as Promise<WorktreeScriptModule>;
}

describe("worktree helper", () => {
  it("passes its end-to-end self-test", () => {
    const result = spawnSync(process.execPath, [path.join(process.cwd(), "scripts/worktree.mjs"), "--self-test"], {
      encoding: "utf8",
      timeout: 120_000,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("SELF-TEST PASS");
  }, 120_000);

  it("classifies cleanup buckets", async () => {
    const { classifyWorktree } = await loadWorktreeScript();

    expect(classifyWorktree({ trackedChanges: 1 })).toBe("hold-wip");
    expect(classifyWorktree({ untrackedChanges: 2 })).toBe("hold-scratch");
    expect(classifyWorktree({ prState: "OPEN" })).toBe("hold-open-pr");
    expect(classifyWorktree({ merged: true, recent: true })).toBe("safe");
    expect(classifyWorktree({ prState: "MERGED", recent: true })).toBe("safe");
    expect(classifyWorktree({ prState: "CLOSED" })).toBe("review");
    expect(classifyWorktree({ recent: true })).toBe("recent");
    expect(classifyWorktree({})).toBe("review");
  });
});
