import { describe, expect, it } from "vitest";
import {
  type AcContext,
  type AcQuery,
  detectQuery,
  FOLDER_PREFIX,
  resolve,
  suggest,
} from "../src/ui/autocomplete";
import { visibleCommands } from "../src/ui/commands";

const context = (over: Partial<AcContext> = {}): AcContext => ({
  commands: visibleCommands(),
  skills: [
    { name: "summarize", description: "Summarize the note" },
    { name: "translate", description: "Translate text" },
  ],
  files: [
    { path: "Daily/2026-06-14.md", type: "file" },
    { path: "Projects", type: "folder" },
    { path: "Projects/roadmap.md", type: "file" },
  ],
  ...over,
});

describe("detectQuery", () => {
  it("detects a command token at the start", () => {
    expect(detectQuery("/sk", 3)).toEqual({ kind: "command", range: [0, 3], query: "sk" });
  });
  it("detects an empty command on a lone slash", () => {
    expect(detectQuery("/", 1)).toEqual({ kind: "command", range: [0, 1], query: "" });
  });
  it("stops treating it as a command once a space is typed", () => {
    expect(detectQuery("/new ", 5)).toBeNull();
  });
  it("detects a skill argument after /skill", () => {
    expect(detectQuery("/skill sum", 10)).toEqual({ kind: "skill", range: [7, 10], query: "sum" });
  });
  it("detects an empty skill arg right after the space", () => {
    expect(detectQuery("/skill ", 7)).toEqual({ kind: "skill", range: [7, 7], query: "" });
  });
  it("treats /template like /skill for arg completion", () => {
    expect(detectQuery("/template tr", 12)).toEqual({ kind: "skill", range: [10, 12], query: "tr" });
  });
  it("closes skill completion once a second arg begins", () => {
    expect(detectQuery("/skill summarize foo", 20)).toBeNull();
  });
  it("detects a mention at the start of input", () => {
    expect(detectQuery("@Dai", 4)).toEqual({ kind: "mention", range: [0, 4], query: "Dai" });
  });
  it("detects a mention after whitespace mid-message", () => {
    expect(detectQuery("see @road", 9)).toEqual({ kind: "mention", range: [4, 9], query: "road" });
  });
  it("does not treat an @ inside a word as a mention", () => {
    expect(detectQuery("email@x", 7)).toBeNull();
  });
  it("keeps the mention open across spaces for multi-word paths", () => {
    expect(detectQuery("@200 Resources", 14)).toEqual({
      kind: "mention",
      range: [0, 14],
      query: "200 Resources",
    });
  });
  it("closes the mention at a line break", () => {
    expect(detectQuery("@Daily\nnext", 11)).toBeNull();
  });
  it("uses the caret, ignoring text to its right", () => {
    expect(detectQuery("/sk extra", 3)).toEqual({ kind: "command", range: [0, 3], query: "sk" });
  });
  it("returns null for plain text", () => {
    expect(detectQuery("hello world", 11)).toBeNull();
  });
});

describe("suggest — commands", () => {
  it("filters commands by name substring", () => {
    const items = suggest({ kind: "command", range: [0, 3], query: "us" }, context());
    expect(items.map((i) => i.value)).toContain("usage");
    expect(items.every((i) => i.value.includes("us") || i.label.includes("us"))).toBe(true);
  });
  it("matches aliases but reports the canonical name", () => {
    const items = suggest({ kind: "command", range: [0, 5], query: "hist" }, context());
    expect(items.map((i) => i.value)).toContain("sessions");
  });
  it("lists all commands for an empty query in registry order", () => {
    const items = suggest({ kind: "command", range: [0, 1], query: "" }, context());
    expect(items[0].value).toBe("new");
    expect(items.map((i) => i.value)).not.toContain("template"); // hidden
  });
  it("ranks earlier matches first", () => {
    const items = suggest({ kind: "command", range: [0, 2], query: "s" }, context());
    // "sessions"/"status"/"skill" start with s (score 0); "usage" has s at index 2.
    expect(items[items.length - 1].value).toBe("usage");
  });
});

describe("suggest — skills", () => {
  it("filters skills by name", () => {
    const items = suggest({ kind: "skill", range: [7, 10], query: "sum" }, context());
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "skill", label: "summarize", value: "summarize" });
  });
  it("returns all skills for an empty query", () => {
    const items = suggest({ kind: "skill", range: [7, 7], query: "" }, context());
    expect(items.map((i) => i.value)).toEqual(["summarize", "translate"]);
  });
});

describe("suggest — mentions", () => {
  it("matches files by basename and folders by path", () => {
    const items = suggest({ kind: "mention", range: [0, 5], query: "road" }, context());
    expect(items.map((i) => i.value)).toEqual(["Projects/roadmap.md"]);
  });
  it("encodes folders with the folder prefix", () => {
    const items = suggest({ kind: "mention", range: [0, 5], query: "Projects" }, context());
    const folder = items.find((i) => i.label === "Projects");
    expect(folder?.value).toBe(`${FOLDER_PREFIX}Projects`);
    expect(folder?.icon).toBe("folder");
  });
  it("excludes non-matches", () => {
    const items = suggest({ kind: "mention", range: [0, 3], query: "zzz" }, context());
    expect(items).toHaveLength(0);
  });
  it("matches a multi-word folder path with spaces", () => {
    const items = suggest(
      { kind: "mention", range: [0, 14], query: "200 Resources" },
      context({ files: [{ path: "200 Resources", type: "folder" }] }),
    );
    expect(items.map((i) => i.value)).toEqual([`${FOLDER_PREFIX}200 Resources`]);
  });
});

describe("resolve", () => {
  const q = (over: Partial<AcQuery>): AcQuery => ({ kind: "command", range: [0, 0], query: "", ...over });

  it("fills a command with a trailing space", () => {
    const out = resolve("/sk", q({ kind: "command", range: [0, 3] }), {
      kind: "command",
      label: "/skill",
      detail: "",
      icon: "terminal",
      value: "skill",
    });
    expect(out).toEqual({ text: "/skill ", caret: 7 });
  });
  it("fills a skill name into the /skill argument", () => {
    const out = resolve("/skill sum", q({ kind: "skill", range: [7, 10] }), {
      kind: "skill",
      label: "summarize",
      detail: "",
      icon: "sparkles",
      value: "summarize",
    });
    expect(out).toEqual({ text: "/skill summarize ", caret: 17 });
  });
  it("strips a mention token and returns the attachment entry", () => {
    const out = resolve("see @road", q({ kind: "mention", range: [4, 9] }), {
      kind: "mention",
      label: "roadmap.md",
      detail: "Projects/roadmap.md",
      icon: "file-text",
      value: "Projects/roadmap.md",
    });
    expect(out).toEqual({ text: "see ", caret: 4, attach: "Projects/roadmap.md" });
  });
  it("preserves text after the caret when resolving mid-string", () => {
    const out = resolve("a @x b", { kind: "mention", range: [2, 4], query: "x" }, {
      kind: "mention",
      label: "x.md",
      detail: "x.md",
      icon: "file-text",
      value: "x.md",
    });
    expect(out).toEqual({ text: "a  b", caret: 2, attach: "x.md" });
  });
});
