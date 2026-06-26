import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import { FOLDER_PREFIX } from "../src/ui/autocomplete";
import { MAX_ACTIVE_NOTE_CHARS } from "../src/ui/active-note";
import { buildPromptContext, loadImageAttachments, visibleEditorRange } from "../src/ui/context-builder";
import { createTextContextAttachment, MAX_TEXT_CONTEXT_CHARS } from "../src/ui/context-attachments";
import { FakeApp } from "./helpers/fake-vault";

function app(): FakeApp & App {
  return new FakeApp() as FakeApp & App;
}

describe("buildPromptContext", () => {
  it("serializes active note and explicit note attachments while skipping image text context", async () => {
    const fake = app();
    await fake.vault.create("Active.md", "active body");
    await fake.vault.create("Other.md", "other body");
    await fake.vault.create("Image.png", "PNG bytes should not be text context");

    const context = await buildPromptContext({
      app: fake,
      activeNotePath: "Active.md",
      attachments: ["Other.md", "Image.png"],
      isPathIgnored: () => false,
    });

    expect(context).toContain('Active note "Active.md"');
    expect(context).toContain("active body");
    expect(context).toContain('Contents of note "Other.md"');
    expect(context).toContain("other body");
    expect(context).not.toContain("PNG bytes should not be text context");
  });

  it("withholds ignored active-note and attachment contents", async () => {
    const fake = app();
    await fake.vault.createFolder("Private");
    await fake.vault.create("Private/Secret.md", "TOP SECRET");

    const context = await buildPromptContext({
      app: fake,
      activeNotePath: "Private/Secret.md",
      attachments: ["Private/Secret.md"],
      isPathIgnored: (path) => path.startsWith("Private/"),
    });

    expect(context).toContain("Private/Secret.md");
    expect(context).toContain("contents are withheld");
    expect(context).not.toContain("TOP SECRET");
  });

  it("serializes heading-level note attachments as a section slice", async () => {
    const fake = app();
    await fake.vault.createFolder("Projects");
    await fake.vault.create(
      "Projects/Plan.md",
      [
        "# Overview",
        "overview body",
        "## Target",
        "target body",
        "### Detail",
        "detail body",
        "## Later",
        "later body",
      ].join("\n"),
    );

    const context = await buildPromptContext({
      app: fake,
      activeNotePath: null,
      attachments: ["Projects/Plan.md#Target"],
      isPathIgnored: () => false,
    });

    expect(context).toContain('Contents of note "Projects/Plan.md#Target"');
    expect(context).toContain("target body");
    expect(context).toContain("detail body");
    expect(context).not.toContain("overview body");
    expect(context).not.toContain("later body");
  });

  it("serializes block-level note attachments as a bounded block slice", async () => {
    const fake = app();
    await fake.vault.createFolder("Notes");
    await fake.vault.create(
      "Notes/Blocks.md",
      ["first paragraph", "", "- keep this", "- and this ^todo-block", "", "next paragraph"].join("\n"),
    );

    const context = await buildPromptContext({
      app: fake,
      activeNotePath: null,
      attachments: ["Notes/Blocks.md^todo-block"],
      isPathIgnored: () => false,
    });

    expect(context).toContain('Contents of note "Notes/Blocks.md^todo-block"');
    expect(context).toContain("- keep this");
    expect(context).toContain("- and this ^todo-block");
    expect(context).not.toContain("first paragraph");
    expect(context).not.toContain("next paragraph");
  });

  it("withholds ignored subref attachment contents based on the base path", async () => {
    const fake = app();
    await fake.vault.createFolder("Private");
    await fake.vault.create("Private/Secret.md", "# Target\nTOP SECRET");

    const context = await buildPromptContext({
      app: fake,
      activeNotePath: null,
      attachments: ["Private/Secret.md#Target"],
      isPathIgnored: (path) => path.startsWith("Private/"),
    });

    expect(context).toContain("Private/Secret.md#Target");
    expect(context).toContain("contents are withheld");
    expect(context).not.toContain("TOP SECRET");
  });

  it("keeps a path reference when a heading or block ref is missing", async () => {
    const fake = app();
    await fake.vault.create("Note.md", "# Other\nbody");

    const context = await buildPromptContext({
      app: fake,
      activeNotePath: null,
      attachments: ["Note.md#Missing"],
      isPathIgnored: () => false,
    });

    expect(context).toContain('Note "Note.md#Missing" is attached by reference');
    expect(context).toContain('Use the read tool to open "Note.md"');
    expect(context).not.toContain("body");
  });

  it("adds folder listings and filters ignored children", async () => {
    const fake = app();
    await fake.vault.createFolder("Notes");
    await fake.vault.createFolder("Notes/Sub");
    await fake.vault.create("Notes/Public.md", "public");
    await fake.vault.create("Notes/Secret.md", "secret");

    const context = await buildPromptContext({
      app: fake,
      activeNotePath: null,
      attachments: [`${FOLDER_PREFIX}Notes`],
      isPathIgnored: (path) => path.endsWith("Secret.md"),
    });

    expect(context).toContain('Folder listing for "Notes"');
    expect(context).toContain("Public.md");
    expect(context).toContain("Sub/");
    expect(context).not.toContain("Secret.md");
  });

  it("serializes selected editor text attachments", async () => {
    const context = await buildPromptContext({
      app: app(),
      activeNotePath: null,
      attachments: [createTextContextAttachment({ text: "selected body", sourcePath: "Note.md" })],
      isPathIgnored: () => false,
    });

    expect(context).toContain('Selected text from "Note.md"');
    expect(context).toContain("selected body");
  });

  it("withholds selected text from ignored notes", async () => {
    const context = await buildPromptContext({
      app: app(),
      activeNotePath: null,
      attachments: [createTextContextAttachment({ text: "TOP SECRET", sourcePath: "Private/Secret.md" })],
      isPathIgnored: (path) => path.startsWith("Private/"),
    });

    expect(context).toContain("contents are withheld");
    expect(context).not.toContain("TOP SECRET");
  });

  it("truncates oversized selected text attachments visibly", async () => {
    const context = await buildPromptContext({
      app: app(),
      activeNotePath: null,
      attachments: [createTextContextAttachment({ text: "x".repeat(MAX_TEXT_CONTEXT_CHARS + 1) })],
      isPathIgnored: () => false,
    });

    expect(context).toContain(`Selected text truncated at ${MAX_TEXT_CONTEXT_CHARS} characters`);
    expect(context).not.toContain("x".repeat(MAX_TEXT_CONTEXT_CHARS + 1));
  });

  it("uses the visible editor range for oversized active notes", async () => {
    const fake = app();
    const file = await fake.vault.create("Long.md", "x".repeat(MAX_ACTIVE_NOTE_CHARS + 1));
    fake.workspace = {
      getActiveFile: () => file,
      getActiveViewOfType: <T,>() =>
        ({
          file,
          editor: {
            lineCount: () => 300,
            getCursor: () => ({ line: 150, ch: 0 }),
            getLine: () => "visible slice",
            getRange: () => "visible slice",
          },
        }) as T,
    } as unknown as typeof fake.workspace;

    const context = await buildPromptContext({
      app: fake,
      activeNotePath: "Long.md",
      attachments: [],
      isPathIgnored: () => false,
    });

    expect(context).toContain("visible in the editor");
    expect(context).toContain("visible slice");
    expect(context).not.toContain("x".repeat(MAX_ACTIVE_NOTE_CHARS + 1));
  });

  it("returns an empty string when no context sections are present", async () => {
    const context = await buildPromptContext({
      app: app(),
      activeNotePath: null,
      attachments: [],
      isPathIgnored: () => false,
    });

    expect(context).toBe("");
  });
});

describe("loadImageAttachments", () => {
  it("encodes readable image attachments only when the model supports images", async () => {
    const fake = app();
    await fake.vault.create("Image.png", "");
    await fake.vault.create("Note.md", "text");
    Object.assign(fake.vault, {
      readBinary: async () => new Uint8Array([1, 2, 3]).buffer,
    });

    await expect(
      loadImageAttachments({ app: fake, attachments: ["Image.png"], supportsImages: false }),
    ).resolves.toEqual([]);

    const images = await loadImageAttachments({
      app: fake,
      attachments: ["Image.png", "Note.md", "Missing.png"],
      supportsImages: true,
    });

    expect(images).toEqual([{ type: "image", data: "AQID", mimeType: "image/png" }]);
  });
});

describe("visibleEditorRange", () => {
  it("returns null when no matching Markdown editor is active", async () => {
    const fake = app();
    const file = await fake.vault.create("A.md", "body");
    fake.workspace = {
      getActiveFile: () => null,
      getActiveViewOfType: () => null,
    } as unknown as typeof fake.workspace;

    expect(visibleEditorRange(fake, file)).toBeNull();
  });
});
