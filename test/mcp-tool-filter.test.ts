import { describe, it, expect } from "vitest";
import {
  healMcpToolGlobs,
  createToolGlobMatcher,
  filterMcpToolsByGlobs,
  MAX_MCP_TOOL_GLOB_PATTERNS,
  MAX_MCP_TOOL_GLOB_LENGTH,
} from "../src/mcp/tool-filter";

describe("healMcpToolGlobs", () => {
  it("heals array of strings, trims, drops empties and comments", () => {
    expect(healMcpToolGlobs(["  read_*  ", "", "  ", "# comment", "write_*", "read_*", "READ_*"])).toEqual(["read_*", "write_*"]);
  });

  it("handles comma and newline separated strings", () => {
    expect(healMcpToolGlobs("read_*, write_*\n*_danger, # comment\n\nsecret_*")).toEqual(["read_*", "write_*", "*_danger", "secret_*"]);
  });

  it("returns empty for non-array/non-string", () => {
    expect(healMcpToolGlobs(null)).toEqual([]);
    expect(healMcpToolGlobs(undefined)).toEqual([]);
    expect(healMcpToolGlobs(123 as unknown as string[])).toEqual([]);
    expect(healMcpToolGlobs({} as unknown as string[])).toEqual([]);
  });

  it("drops non-string entries", () => {
    expect(healMcpToolGlobs(["ok", 123, null, undefined, "also"] as unknown as string[])).toEqual(["ok", "also"]);
  });

  it("caps length and count", () => {
    const long = "a".repeat(MAX_MCP_TOOL_GLOB_LENGTH + 10);
    expect(healMcpToolGlobs([long, "ok"])).toEqual(["ok"]);
    const many = Array.from({ length: MAX_MCP_TOOL_GLOB_PATTERNS + 10 }, (_, i) => `tool_${i}`);
    expect(healMcpToolGlobs(many).length).toBe(MAX_MCP_TOOL_GLOB_PATTERNS);
  });

  it("does not allow prototype pollution via pattern strings", () => {
    const healed = healMcpToolGlobs(["__proto__", "constructor", "prototype", "safe"]);
    expect(healed).toEqual(["__proto__", "constructor", "prototype", "safe"]);
    // Ensure the array itself is not polluting Object.prototype
    expect(({} as Record<string, unknown>).__proto__).not.toBe("polluted");
  });

  it("deduplicates case-insensitively", () => {
    expect(healMcpToolGlobs(["Read_*", "read_*", "READ_*", "write_*"])).toEqual(["Read_*", "write_*"]);
  });
});

describe("createToolGlobMatcher", () => {
  it("matches * wildcards", () => {
    const isMatch = createToolGlobMatcher(["*"]);
    expect(isMatch("anything")).toBe(true);
    expect(isMatch("")).toBe(true);
    expect(isMatch("read_file")).toBe(true);
  });

  it("matches prefix globs read_*", () => {
    const isMatch = createToolGlobMatcher(["read_*"]);
    expect(isMatch("read_file")).toBe(true);
    expect(isMatch("read")).toBe(false);
    expect(isMatch("write_file")).toBe(false);
    expect(isMatch("read_")).toBe(true);
  });

  it("matches suffix globs *_danger", () => {
    const isMatch = createToolGlobMatcher(["*_danger"]);
    expect(isMatch("foo_danger")).toBe(true);
    expect(isMatch("danger")).toBe(false);
    expect(isMatch("foo_danger_extra")).toBe(false);
  });

  it("matches substring globs *a* and case-insensitively", () => {
    const isMatch = createToolGlobMatcher(["*a*"]);
    expect(isMatch("FooBar")).toBe(true);
    expect(isMatch("FOOBAR")).toBe(true);
    expect(isMatch("xyz")).toBe(false);
  });

  it("matches ? single char", () => {
    const isMatch = createToolGlobMatcher(["te?t"]);
    expect(isMatch("test")).toBe(true);
    expect(isMatch("tent")).toBe(true);
    expect(isMatch("te_st")).toBe(false);
    expect(isMatch("tt")).toBe(false);
  });

  it("matches ** like * for tool names", () => {
    const isMatch = createToolGlobMatcher(["**"]);
    expect(isMatch("any_tool")).toBe(true);
    expect(isMatch("a/b")).toBe(true);
  });

  it("handles multiple patterns as OR", () => {
    const isMatch = createToolGlobMatcher(["read_*", "write_*"]);
    expect(isMatch("read_file")).toBe(true);
    expect(isMatch("write_file")).toBe(true);
    expect(isMatch("delete_file")).toBe(false);
  });

  it("escapes regex special chars like . +", () => {
    const isMatch = createToolGlobMatcher(["file.txt"]);
    expect(isMatch("file.txt")).toBe(true);
    expect(isMatch("fileXtxt")).toBe(false);
  });

  it("returns false for empty patterns", () => {
    const isMatch = createToolGlobMatcher([]);
    expect(isMatch("anything")).toBe(false);
    const isMatch2 = createToolGlobMatcher(["", "  ", "# comment"]);
    expect(isMatch2("anything")).toBe(false);
  });

  it("strips leading slash and trailing slash", () => {
    const isMatch = createToolGlobMatcher(["/read_*", "write_*/"]);
    expect(isMatch("read_file")).toBe(true);
    expect(isMatch("write_file")).toBe(true);
  });

  it("is safe against ReDoS with long patterns", () => {
    const longPattern = "b*".repeat(50);
    const isMatch = createToolGlobMatcher([longPattern]);
    // "a".repeat(100) cannot match b*a*... pattern, should not hang and return false
    expect(isMatch("a".repeat(100))).toBe(false);
    expect(isMatch("b".repeat(100))).toBe(true);
  });
});

describe("filterMcpToolsByGlobs", () => {
  const tools = [
    { name: "read_file" },
    { name: "write_file" },
    { name: "delete_file" },
    { name: "search" },
    { name: "foo_danger" },
  ];

  it("allows all when enabled is empty", () => {
    expect(filterMcpToolsByGlobs(tools, [], []).map((t) => t.name)).toEqual(tools.map((t) => t.name));
  });

  it("filters by enabled allowlist", () => {
    expect(filterMcpToolsByGlobs(tools, ["read_*", "search"], []).map((t) => t.name)).toEqual(["read_file", "search"]);
  });

  it("filters by disabled denylist", () => {
    expect(filterMcpToolsByGlobs(tools, [], ["*_danger", "delete_*"]).map((t) => t.name)).toEqual(["read_file", "write_file", "search"]);
    // Explicit check
    expect(filterMcpToolsByGlobs(tools, [], ["delete_*"]).map((t) => t.name)).toEqual(["read_file", "write_file", "search", "foo_danger"]);
    expect(filterMcpToolsByGlobs(tools, [], ["*_danger"]).map((t) => t.name)).not.toContain("foo_danger");
  });

  it("deny wins over allow", () => {
    const filtered = filterMcpToolsByGlobs(tools, ["*"], ["*_danger", "delete_*"]);
    expect(filtered.map((t) => t.name)).toEqual(["read_file", "write_file", "search"]);
    expect(filtered.map((t) => t.name)).not.toContain("delete_file");
    expect(filtered.map((t) => t.name)).not.toContain("foo_danger");
  });

  it("enabled + disabled with overlapping patterns", () => {
    const filtered = filterMcpToolsByGlobs(tools, ["read_*", "write_*"], ["read_file"]);
    expect(filtered.map((t) => t.name)).toEqual(["write_file"]);
  });

  it("case-insensitive matching", () => {
    expect(filterMcpToolsByGlobs([{ name: "Read_File" }], ["read_*"], []).length).toBe(1);
    expect(filterMcpToolsByGlobs([{ name: "Read_File" }], [], ["READ_*"]).length).toBe(0);
  });

  it("handles empty tools array", () => {
    expect(filterMcpToolsByGlobs([], ["*"], [])).toEqual([]);
  });

  it("drops __proto__ pattern safely without polluting", () => {
    const filtered = filterMcpToolsByGlobs([{ name: "__proto__" }, { name: "safe" }], ["__proto__"], []);
    expect(filtered.map((t) => t.name)).toEqual(["__proto__"]);
    expect(({} as Record<string, unknown>).__proto__).not.toBe("polluted");
  });

  it("preserves order of original tools", () => {
    const filtered = filterMcpToolsByGlobs(tools, ["*"], ["search"]);
    expect(filtered.map((t) => t.name)).toEqual(["read_file", "write_file", "delete_file", "foo_danger"]);
  });
});
