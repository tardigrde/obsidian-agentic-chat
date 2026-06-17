import { describe, expect, it } from "vitest";
import {
  isInsideWorkingDirs,
  normalizeWorkingDirs,
  resolveWorkingDirPolicy,
  toolTargetPaths,
} from "../src/agent/working-dir";

describe("toolTargetPaths", () => {
  it("extracts and normalizes path + newPath, ignoring other fields", () => {
    expect(toolTargetPaths({ path: "Notes/a.md", content: "x" })).toEqual(["Notes/a.md"]);
    expect(toolTargetPaths({ path: "a.md", newPath: "Archive/a.md" })).toEqual(["a.md", "Archive/a.md"]);
    expect(toolTargetPaths({ path: "./Notes/a.md" })).toEqual(["Notes/a.md"]);
  });

  it("returns [] for pathless calls and non-object args", () => {
    expect(toolTargetPaths({ pattern: "foo" })).toEqual([]);
    expect(toolTargetPaths({})).toEqual([]);
    expect(toolTargetPaths(undefined)).toEqual([]);
    expect(toolTargetPaths("nope")).toEqual([]);
    expect(toolTargetPaths({ path: "" })).toEqual([]);
  });

  it("drops absolute or escaping paths rather than throwing", () => {
    expect(toolTargetPaths({ path: "/etc/passwd" })).toEqual([]);
    expect(toolTargetPaths({ path: "../outside.md" })).toEqual([]);
  });
});

describe("normalizeWorkingDirs", () => {
  it("normalizes, de-duplicates, and drops invalid entries", () => {
    expect(normalizeWorkingDirs(["Notes/", "Notes", "Work/Sub"])).toEqual(["Notes", "Work/Sub"]);
    expect(normalizeWorkingDirs(["", "/"])).toEqual([""]);
    expect(normalizeWorkingDirs(["../escape", "ok"])).toEqual(["ok"]);
  });
});

describe("isInsideWorkingDirs", () => {
  it("matches a path at or under a granted dir, with a true segment boundary", () => {
    expect(isInsideWorkingDirs("Notes/a.md", ["Notes"])).toBe(true);
    expect(isInsideWorkingDirs("Notes", ["Notes"])).toBe(true);
    expect(isInsideWorkingDirs("Other/a.md", ["Notes"])).toBe(false);
    // "Notesx" must not count as inside "Notes".
    expect(isInsideWorkingDirs("Notesx/a.md", ["Notes"])).toBe(false);
  });

  it("treats the root scope ('') as matching everything", () => {
    expect(isInsideWorkingDirs("anywhere/a.md", [""])).toBe(true);
  });
});

describe("resolveWorkingDirPolicy", () => {
  it("leaves the base policy unchanged when no dirs are configured", () => {
    expect(resolveWorkingDirPolicy([], { path: "a.md" }, "ask")).toBe("ask");
    expect(resolveWorkingDirPolicy([], { path: "a.md" }, "allow")).toBe("allow");
  });

  it("always preserves an explicit deny (per-tool / plan)", () => {
    expect(resolveWorkingDirPolicy(["Notes"], { path: "Notes/a.md" }, "deny")).toBe("deny");
  });

  it("auto-runs targets inside a granted dir, overriding ask", () => {
    expect(resolveWorkingDirPolicy(["Notes"], { path: "Notes/a.md" }, "ask")).toBe("allow");
  });

  it("routes out-of-scope targets through ask, even read-only allows", () => {
    expect(resolveWorkingDirPolicy(["Notes"], { path: "Other/a.md" }, "allow")).toBe("ask");
    expect(resolveWorkingDirPolicy(["Notes"], { path: "Other/a.md" }, "ask")).toBe("ask");
  });

  it("asks when a rename moves a file out of the working set", () => {
    expect(resolveWorkingDirPolicy(["Notes"], { path: "Notes/a.md", newPath: "Out/a.md" }, "ask")).toBe("ask");
    expect(resolveWorkingDirPolicy(["Notes"], { path: "Notes/a.md", newPath: "Notes/b.md" }, "ask")).toBe("allow");
  });

  it("leaves pathless calls on the base policy", () => {
    expect(resolveWorkingDirPolicy(["Notes"], { pattern: "foo" }, "allow")).toBe("allow");
  });
});
