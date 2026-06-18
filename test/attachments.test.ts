import { describe, expect, it } from "vitest";
import { buildAttachmentSection, MAX_ATTACHMENT_CHARS } from "../src/ui/attachments";

describe("buildAttachmentSection", () => {
  it("inlines a note that fits the budget", () => {
    const section = buildAttachmentSection({ path: "Note.md", full: "small body" });
    expect(section).toContain("Contents of note");
    expect(section).toContain("small body");
  });

  it("inlines up to the default budget boundary exactly", () => {
    const exact = "x".repeat(MAX_ATTACHMENT_CHARS);
    const section = buildAttachmentSection({ path: "Note.md", full: exact });
    expect(section).toContain(exact);
  });

  it("switches to a path-only reference when over the budget (no body inlined)", () => {
    const huge = "x".repeat(MAX_ATTACHMENT_CHARS + 1);
    const section = buildAttachmentSection({ path: "Big.md", full: huge });
    expect(section).not.toContain(huge);
    expect(section).toContain("Big.md");
    expect(section).toContain("read tool");
  });

  it("honours a custom limit", () => {
    const section = buildAttachmentSection({ path: "Note.md", full: "abcdefghij", limit: 5 });
    expect(section).not.toContain("abcdefghij");
    expect(section).toContain("read tool");
  });

  it("emits a path-only reference when the note can't be read", () => {
    const section = buildAttachmentSection({ path: "Note.md", full: null });
    expect(section).toContain("could not be read");
    expect(section).toContain("read tool");
  });

  it("never inlines content for a restricted (ignore-listed) path", () => {
    const section = buildAttachmentSection({ path: "private/Secret.md", full: "TOP SECRET", restricted: true });
    expect(section).not.toContain("TOP SECRET");
    expect(section).toContain("restricted");
    expect(section).toContain("withheld");
  });
});
