import { describe, expect, it } from "vitest";
import { ComposerHistory, caretOnEdgeLine } from "../src/ui/composer-history";

describe("ComposerHistory", () => {
  it("records submitted messages, skips consecutive duplicates, and caps the list", () => {
    const history = new ComposerHistory([], 3);
    history.record("one");
    history.record("one");
    history.record("two");
    history.record("three");
    history.record("four");

    expect(history.entries()).toEqual(["two", "three", "four"]);
  });

  it("recalls older entries with Up and swallows Up at the oldest entry without wrapping", () => {
    const history = new ComposerHistory(["first", "second"]);

    expect(history.recall(-1, singleLine("draft"))).toEqual({ handled: true, value: "second" });
    expect(history.recall(-1, singleLine("second"))).toEqual({ handled: true, value: "first" });
    expect(history.recall(-1, singleLine("first"))).toEqual({ handled: true });
  });

  it("recalls newer entries with Down and restores the original draft after the newest entry", () => {
    const history = new ComposerHistory(["first", "second"]);

    expect(history.recall(-1, singleLine("draft"))).toEqual({ handled: true, value: "second" });
    expect(history.recall(-1, singleLine("second"))).toEqual({ handled: true, value: "first" });
    expect(history.recall(1, singleLine("first"))).toEqual({ handled: true, value: "second" });
    expect(history.recall(1, singleLine("second"))).toEqual({ handled: true, value: "draft" });
    expect(history.recall(1, singleLine("draft"))).toEqual({ handled: false });
  });

  it("resets in-progress navigation when a new message is recorded", () => {
    const history = new ComposerHistory(["old"]);

    expect(history.recall(-1, singleLine("draft"))).toEqual({ handled: true, value: "old" });
    history.record("new");

    expect(history.recall(1, singleLine("old"))).toEqual({ handled: false });
    expect(history.recall(-1, singleLine("draft"))).toEqual({ handled: true, value: "new" });
  });

  it("loads tab-scoped history and resets navigation state", () => {
    const history = new ComposerHistory(["one"]);

    expect(history.recall(-1, singleLine("draft"))).toEqual({ handled: true, value: "one" });
    history.load(["other"]);

    expect(history.entries()).toEqual(["other"]);
    expect(history.recall(1, singleLine("one"))).toEqual({ handled: false });
    expect(history.recall(-1, singleLine("draft"))).toEqual({ handled: true, value: "other" });
  });
});

describe("caretOnEdgeLine", () => {
  it("allows Up only from the first line and Down only from the last line", () => {
    const value = "first\nmiddle\nlast";
    expect(caretOnEdgeLine({ value, selectionStart: 0 }, -1)).toBe(true);
    expect(caretOnEdgeLine({ value, selectionStart: 5 }, -1)).toBe(true);
    expect(caretOnEdgeLine({ value, selectionStart: 6 }, -1)).toBe(false);

    expect(caretOnEdgeLine({ value, selectionStart: 12 }, 1)).toBe(false);
    expect(caretOnEdgeLine({ value, selectionStart: 13 }, 1)).toBe(true);
    expect(caretOnEdgeLine({ value, selectionStart: value.length }, 1)).toBe(true);
  });

  it("does not consume arrows while a selection is active", () => {
    expect(caretOnEdgeLine({ value: "draft", selectionStart: 0, selectionEnd: 2 }, -1)).toBe(false);
    expect(caretOnEdgeLine({ value: "draft", selectionStart: 0, selectionEnd: 2 }, 1)).toBe(false);
  });
});

function singleLine(value: string) {
  return { value, selectionStart: value.length, selectionEnd: value.length };
}
