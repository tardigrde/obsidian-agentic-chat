import { describe, expect, it } from "vitest";
import { TFile } from "obsidian";
import {
  assistantImageSourcePath,
  fixupRenderedAssistantImages,
  resolveVaultImageResource,
  rewriteAssistantMarkdownImages,
} from "../src/ui/assistant-bubble";

class FakeEl {
  readonly children: FakeEl[] = [];
  private readonly attrs: Record<string, string> = {};
  private readonly classes = new Set<string>();

  constructor(
    readonly tagName: string,
    attrs: Record<string, string> = {},
    classes: string[] = [],
  ) {
    Object.assign(this.attrs, attrs);
    for (const cls of classes) this.classes.add(cls);
  }

  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }

  addClass(value: string): void {
    this.classes.add(value);
  }

  removeClass(value: string): void {
    this.classes.delete(value);
  }

  hasClass(value: string): boolean {
    return this.classes.has(value);
  }

  empty(): void {
    this.children.splice(0);
  }

  createEl(tag: string, opts?: { attr?: Record<string, string> }): FakeEl {
    const child = new FakeEl(tag, opts?.attr ?? {});
    this.children.push(child);
    return child;
  }

  querySelector(selector: string): FakeEl | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeEl[] {
    const all = [...this.walk()];
    if (selector === "img") return all.filter((el) => el.tagName === "img");
    if (selector === ".internal-embed") return all.filter((el) => el.hasClass("internal-embed"));
    return [];
  }

  private *walk(): Generator<FakeEl> {
    for (const child of this.children) {
      yield child;
      yield* child.walk();
    }
  }
}

function imageFile(path: string): TFile {
  const file = new TFile();
  file.path = path;
  file.name = path.split("/").pop() ?? path;
  return file;
}

function fakeApp(files: Record<string, TFile> = {}) {
  return {
    workspace: { getActiveFile: () => ({ path: "notes/active.md" }) },
    metadataCache: {
      getFirstLinkpathDest: (linkpath: string) => files[linkpath] ?? null,
    },
    vault: {
      getFileByPath: (path: string) => files[path] ?? null,
      getResourcePath: (file: TFile) => `app://resource/${file.path}`,
    },
  } as unknown as Parameters<typeof resolveVaultImageResource>[0];
}

describe("assistantImageSourcePath", () => {
  it("returns the active note path for link resolution", () => {
    expect(assistantImageSourcePath(fakeApp())).toBe("notes/active.md");
  });

  it("degrades to empty string without an active file", () => {
    const app = { workspace: { getActiveFile: () => null } } as unknown as Parameters<
      typeof assistantImageSourcePath
    >[0];
    expect(assistantImageSourcePath(app)).toBe("");
    expect(assistantImageSourcePath({} as never)).toBe("");
    const throwing = {
      workspace: {
        getActiveFile: () => {
          throw new Error("no workspace");
        },
      },
    } as unknown as Parameters<typeof assistantImageSourcePath>[0];
    expect(assistantImageSourcePath(throwing)).toBe("");
  });
});

describe("resolveVaultImageResource", () => {
  it("resolves a vault image to its resource URL", () => {
    const app = fakeApp({ "pic.png": imageFile("images/pic.png") });
    // Link-resolution via basename still returns the file object.
    expect(resolveVaultImageResource(app, "pic.png", "notes/active.md")).toBe("app://resource/images/pic.png");
  });

  it("falls back to a direct vault lookup for root-relative paths", () => {
    const app = {
      workspace: {},
      metadataCache: { getFirstLinkpathDest: () => null },
      vault: {
        getFileByPath: (path: string) => (path === "images/pic.png" ? imageFile(path) : null),
        getResourcePath: (file: TFile) => `app://resource/${file.path}`,
      },
    } as unknown as Parameters<typeof resolveVaultImageResource>[0];
    expect(resolveVaultImageResource(app, "images/pic.png", "other/note.md")).toBe(
      "app://resource/images/pic.png",
    );
  });

  it("rejects external sources, non-images, and missing files", () => {
    const app = fakeApp({ "note.md": imageFile("note.md"), "pic.png": imageFile("images/pic.png") });
    expect(resolveVaultImageResource(app, "https://example.com/a.png", "")).toBeNull();
    expect(resolveVaultImageResource(app, "data:image/png;base64,x", "")).toBeNull();
    expect(resolveVaultImageResource(app, "note.md", "")).toBeNull();
    expect(resolveVaultImageResource(app, "gone.png", "")).toBeNull();
    expect(resolveVaultImageResource(app, "  ", "")).toBeNull();
  });
});

describe("rewriteAssistantMarkdownImages", () => {
  it("rewrites wiki embeds and vault-relative destinations", () => {
    const app = fakeApp({ "pic.png": imageFile("images/pic.png") });
    expect(rewriteAssistantMarkdownImages(app, "See ![[pic.png]]!", "notes/active.md")).toBe(
      "See ![pic.png](app://resource/images/pic.png)!",
    );
  });

  it("leaves unresolvable targets for the renderer", () => {
    const app = fakeApp();
    expect(rewriteAssistantMarkdownImages(app, "See ![[gone.png]]!", "")).toBe("See ![[gone.png]]!");
  });

  it("threads the sourcePath into resolution", () => {
    const strictApp = {
      workspace: {},
      metadataCache: {
        getFirstLinkpathDest: (linkpath: string, sourcePath: string) =>
          sourcePath === "notes/active.md" && linkpath === "pic.png" ? imageFile("images/pic.png") : null,
      },
      vault: {
        getFileByPath: () => null,
        getResourcePath: (file: TFile) => `app://resource/${file.path}`,
      },
    } as unknown as Parameters<typeof resolveVaultImageResource>[0];
    expect(rewriteAssistantMarkdownImages(strictApp, "See ![[pic.png]]!", "notes/active.md")).toBe(
      "See ![pic.png](app://resource/images/pic.png)!",
    );
    // A wrong sourcePath leaves the embed for the renderer instead of mis-resolving.
    expect(rewriteAssistantMarkdownImages(strictApp, "See ![[pic.png]]!", "other/note.md")).toBe(
      "See ![[pic.png]]!",
    );
  });

  it("prefers link resolution over the direct vault lookup", () => {
    const app = {
      workspace: {},
      metadataCache: {
        getFirstLinkpathDest: () => imageFile("via-links/pic.png"),
      },
      vault: {
        getFileByPath: () => imageFile("direct/pic.png"),
        getResourcePath: (file: TFile) => `app://resource/${file.path}`,
      },
    } as unknown as Parameters<typeof resolveVaultImageResource>[0];
    expect(resolveVaultImageResource(app, "pic.png", "")).toBe("app://resource/via-links/pic.png");
  });

  it("decodes percent-encoded targets and tolerates bad encodings", () => {
    const app = fakeApp({ "my pic.png": imageFile("images/my pic.png") });
    expect(resolveVaultImageResource(app, "my%20pic.png", "")).toBe("app://resource/images/my pic.png");
    expect(resolveVaultImageResource(app, "100%.png", "")).toBeNull();
  });
});

describe("fixupRenderedAssistantImages", () => {
  it("points vault-path img srcs at resource URLs and skips external ones", () => {
    const app = fakeApp({ "images/pic.png": imageFile("images/pic.png") });
    const root = new FakeEl("div");
    root.children.push(new FakeEl("img", { src: "images/pic.png" }));
    root.children.push(new FakeEl("img", { src: "https://example.com/a.png" }));

    fixupRenderedAssistantImages(root as unknown as HTMLElement, app, "");

    const [local, remote] = root.querySelectorAll("img");
    expect(local.getAttribute("src")).toBe("app://resource/images/pic.png");
    expect(local.hasClass("agentic-chat-image")).toBe(true);
    expect(remote.getAttribute("src")).toBe("https://example.com/a.png");
  });

  it("materializes unresolved internal image embeds", () => {
    const app = fakeApp({ "pic.png": imageFile("images/pic.png") });
    const root = new FakeEl("div");
    root.children.push(new FakeEl("div", { src: "pic.png" }, ["internal-embed", "is-unresolved"]));

    fixupRenderedAssistantImages(root as unknown as HTMLElement, app, "notes/active.md");

    const embed = root.querySelector(".internal-embed");
    expect(embed?.hasClass("is-unresolved")).toBe(false);
    expect(embed?.hasClass("image-embed")).toBe(true);
    expect(embed?.querySelector("img")?.getAttribute("src")).toBe("app://resource/images/pic.png");
  });

  it("leaves non-image and unresolvable embeds alone", () => {
    const app = fakeApp();
    const root = new FakeEl("div");
    root.children.push(new FakeEl("div", { src: "note.md" }, ["internal-embed", "is-unresolved"]));
    root.children.push(new FakeEl("div", { src: "gone.png" }, ["internal-embed", "is-unresolved"]));

    fixupRenderedAssistantImages(root as unknown as HTMLElement, app, "");

    for (const embed of root.querySelectorAll(".internal-embed")) {
      expect(embed.querySelector("img")).toBeNull();
      expect(embed.hasClass("is-unresolved")).toBe(true);
    }
  });

  it("leaves already-resolved embeds (containing an img) untouched", () => {
    const app = fakeApp({ "pic.png": imageFile("images/pic.png") });
    const root = new FakeEl("div");
    const embed = new FakeEl("div", { src: "pic.png" }, ["internal-embed", "image-embed"]);
    embed.children.push(new FakeEl("img", { src: "app://resource/images/pic.png" }));
    root.children.push(embed);

    fixupRenderedAssistantImages(root as unknown as HTMLElement, app, "notes/active.md");

    expect(embed.children).toHaveLength(1);
    expect(embed.querySelector("img")?.getAttribute("src")).toBe("app://resource/images/pic.png");
  });
});
