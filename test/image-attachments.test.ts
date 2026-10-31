import { describe, expect, it } from "vitest";
import {
  arrayBufferToBase64,
  collectUserImageThumbs,
  imageBasename,
  imageMimeType,
  isExternalImageSrc,
  isImagePath,
  parseWikiImageTarget,
  rewriteMarkdownImages,
  sanitizeImageMimeType,
  stripImageQueryFragment,
} from "../src/ui/image-attachments";

describe("image-attachments", () => {
  it("detects image paths by extension, case-insensitively", () => {
    expect(isImagePath("Attachments/diagram.png")).toBe(true);
    expect(isImagePath("photo.JPG")).toBe(true);
    expect(isImagePath("clip.webp")).toBe(true);
    expect(isImagePath("note.md")).toBe(false);
    expect(isImagePath("README")).toBe(false);
    expect(isImagePath("png")).toBe(false);
    expect(isImagePath("folder/jpg")).toBe(false);
  });

  it("maps extensions to MIME types, defaulting to PNG", () => {
    expect(imageMimeType("png")).toBe("image/png");
    expect(imageMimeType("JPG")).toBe("image/jpeg");
    expect(imageMimeType("jpeg")).toBe("image/jpeg");
    expect(imageMimeType("gif")).toBe("image/gif");
    expect(imageMimeType("webp")).toBe("image/webp");
    expect(imageMimeType("bmp")).toBe("image/png");
  });

  it("base64-encodes binary image data", () => {
    const buffer = new Uint8Array([104, 105]).buffer; // "hi"
    expect(arrayBufferToBase64(buffer)).toBe("aGk=");
  });

  it("encodes data larger than one chunk correctly", () => {
    // Spans several 4 KiB chunks to exercise the chunk-boundary stitching.
    const bytes = new Uint8Array(10_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
    const expected = Buffer.from(bytes).toString("base64");
    expect(arrayBufferToBase64(bytes.buffer)).toBe(expected);
  });
});

describe("chat image markdown helpers", () => {
  const resolve = (target: string): string | null =>
    target === "missing.png" ? null : `app://resource/${target}`;

  it("detects already-renderable image sources", () => {
    expect(isExternalImageSrc("https://example.com/a.png")).toBe(true);
    expect(isExternalImageSrc("http://example.com/a.png")).toBe(true);
    expect(isExternalImageSrc("app://local/abc.png")).toBe(true);
    expect(isExternalImageSrc("data:image/png;base64,aaa")).toBe(true);
    expect(isExternalImageSrc("blob:https://x/y")).toBe(true);
    expect(isExternalImageSrc("notes/pic.png")).toBe(false);
    expect(isExternalImageSrc("pic.png")).toBe(false);
  });

  it("treats any URI scheme and protocol-relative URLs as external", () => {
    // Exotic schemes never reach vault lookup — they pass through to the renderer.
    expect(isExternalImageSrc("javascript:alert(1)")).toBe(true);
    expect(isExternalImageSrc("file:///etc/passwd")).toBe(true);
    expect(isExternalImageSrc("//host/x.png")).toBe(true);
    expect(isExternalImageSrc("CAPACITOR://x/y.png")).toBe(true);
  });

  it("strips query/fragment suffixes for extension checks", () => {
    expect(stripImageQueryFragment("pic.png?123")).toBe("pic.png");
    expect(stripImageQueryFragment("pic.png#frag")).toBe("pic.png");
    expect(stripImageQueryFragment("a/pic.png?v=1#x")).toBe("a/pic.png");
    expect(stripImageQueryFragment("pic.png")).toBe("pic.png");
  });

  it("parses wiki embed targets past display suffixes", () => {
    expect(parseWikiImageTarget("pic.png")).toBe("pic.png");
    expect(parseWikiImageTarget("images/pic.png|300")).toBe("images/pic.png");
    expect(parseWikiImageTarget("  pic.png  ")).toBe("pic.png");
  });

  it("derives basenames for alt text", () => {
    expect(imageBasename("images/pic.png")).toBe("pic.png");
    expect(imageBasename("pic.png")).toBe("pic.png");
    expect(imageBasename("pic.png?123")).toBe("pic.png");
  });

  it("rewrites wiki image embeds to resolved markdown images", () => {
    expect(rewriteMarkdownImages("See ![[pic.png]] here", resolve)).toBe(
      "See ![pic.png](app://resource/pic.png) here",
    );
    expect(rewriteMarkdownImages("See ![[images/pic.png|300]] here", resolve)).toBe(
      "See ![pic.png](app://resource/images/pic.png) here",
    );
  });

  it("escapes brackets in generated alt text", () => {
    const bracketResolve = (target: string): string | null => `app://resource/${target}`;
    expect(rewriteMarkdownImages("See ![[a[b.png]] here", bracketResolve)).toBe(
      "See ![ab.png](app://resource/a[b.png) here",
    );
  });

  it("leaves non-image wiki embeds and unresolvable images alone", () => {
    expect(rewriteMarkdownImages("See ![[note.md]] here", resolve)).toBe("See ![[note.md]] here");
    expect(rewriteMarkdownImages("See ![[missing.png]] here", resolve)).toBe("See ![[missing.png]] here");
  });

  it("rewrites vault-relative markdown image destinations", () => {
    expect(rewriteMarkdownImages("![alt](notes/pic.png)", resolve)).toBe("![alt](app://resource/notes/pic.png)");
    expect(rewriteMarkdownImages('![alt](notes/pic.png "title")', resolve)).toBe(
      '![alt](app://resource/notes/pic.png "title")',
    );
  });

  it("leaves external, data, and non-image markdown destinations alone", () => {
    expect(rewriteMarkdownImages("![a](https://example.com/p.png)", resolve)).toBe(
      "![a](https://example.com/p.png)",
    );
    expect(rewriteMarkdownImages("![a](data:image/png;base64,xx)", resolve)).toBe(
      "![a](data:image/png;base64,xx)",
    );
    expect(rewriteMarkdownImages("![a](notes/doc.md)", resolve)).toBe("![a](notes/doc.md)");
    expect(rewriteMarkdownImages("![a](missing.png)", resolve)).toBe("![a](missing.png)");
  });

  it("skips fenced code blocks and inline code spans", () => {
    const fenced = "```\n![[pic.png]]\n```\n\n![[pic.png]]";
    expect(rewriteMarkdownImages(fenced, resolve)).toBe(
      "```\n![[pic.png]]\n```\n\n![pic.png](app://resource/pic.png)",
    );
    expect(rewriteMarkdownImages("`![[pic.png]]` and ![[pic.png]]", resolve)).toBe(
      "`![[pic.png]]` and ![pic.png](app://resource/pic.png)",
    );
  });

  it("handles tilde fences, info strings, and unclosed fences", () => {
    expect(rewriteMarkdownImages("~~~\n![[pic.png]]\n~~~\n\n![[pic.png]]", resolve)).toBe(
      "~~~\n![[pic.png]]\n~~~\n\n![pic.png](app://resource/pic.png)",
    );
    // A closer with an info string does NOT close the fence.
    expect(rewriteMarkdownImages("```\n![[pic.png]]\n```js\n![[pic.png]]\n```", resolve)).toBe(
      "```\n![[pic.png]]\n```js\n![[pic.png]]\n```",
    );
    // An unclosed fence swallows the rest of the document, like the renderer.
    expect(rewriteMarkdownImages("text\n```\n![[pic.png]]", resolve)).toBe("text\n```\n![[pic.png]]");
  });

  it("requires the closer to match the opener's run length", () => {
    // A 3-backtick line does not close a 4-backtick fence.
    const doc = "````\n![[pic.png]]\n```\n![[pic.png]]\n````\n\n![[pic.png]]";
    expect(rewriteMarkdownImages(doc, resolve)).toBe(
      "````\n![[pic.png]]\n```\n![[pic.png]]\n````\n\n![pic.png](app://resource/pic.png)",
    );
  });

  it("ignores indented code and honors blockquote fences", () => {
    // Four-space indentation is an indented code block, not a fence toggle.
    const indented = "text\n\n    ```\n    ![[pic.png]]";
    expect(rewriteMarkdownImages(indented, resolve)).toBe(indented);
    // ...but indented lines mid-paragraph are prose, so images still rewrite.
    expect(rewriteMarkdownImages("text\n    ![[pic.png]]", resolve)).toBe(
      "text\n    ![pic.png](app://resource/pic.png)",
    );
    // Tab-indented blocks after a blank line are code too.
    const tabbed = "text\n\n\t![[pic.png]]";
    expect(rewriteMarkdownImages(tabbed, resolve)).toBe(tabbed);
    expect(rewriteMarkdownImages("> ```\n> ![[pic.png]]\n> ```\n\n![[pic.png]]", resolve)).toBe(
      "> ```\n> ![[pic.png]]\n> ```\n\n![pic.png](app://resource/pic.png)",
    );
  });

  it("skips multi-backtick inline code spans", () => {
    expect(rewriteMarkdownImages("See ```![[pic.png]]``` here", resolve)).toBe("See ```![[pic.png]]``` here");
    expect(rewriteMarkdownImages("See `` `![[pic.png]]` `` here", resolve)).toBe(
      "See `` `![[pic.png]]` `` here",
    );
    // A single unclosed backtick is literal text, so the image still rewrites.
    expect(rewriteMarkdownImages("a `b ![[pic.png]] c", resolve)).toBe(
      "a `b ![pic.png](app://resource/pic.png) c",
    );
  });

  it("rewrites uppercase extensions and bracket/query destinations", () => {
    expect(rewriteMarkdownImages("![[PIC.JPG]]", resolve)).toBe("![PIC.JPG](app://resource/PIC.JPG)");
    expect(rewriteMarkdownImages("![a](<my pic.png>)", resolve)).toBe("![a](app://resource/my pic.png)");
    expect(rewriteMarkdownImages("![a](pic.png?v=2)", resolve)).toBe("![a](app://resource/pic.png?v=2)");
  });

  it("round-trips documents without images unchanged", () => {
    const doc = "# Title\n\nSome **bold** text and `code`.\n\n```js\nconst a = 1;\n```\n";
    expect(rewriteMarkdownImages(doc, resolve)).toBe(doc);
  });

  it("leaves everything untouched when nothing resolves", () => {
    const doc = "See ![[pic.png]] and ![a](other.png).\n\n```\n![[pic.png]]\n```\n";
    expect(rewriteMarkdownImages(doc, () => null)).toBe(doc);
  });
});

describe("sanitizeImageMimeType", () => {
  it("keeps raster image types and falls back to PNG", () => {
    expect(sanitizeImageMimeType("image/png")).toBe("image/png");
    expect(sanitizeImageMimeType("image/jpeg")).toBe("image/jpeg");
    expect(sanitizeImageMimeType("IMAGE/GIF")).toBe("IMAGE/GIF");
    expect(sanitizeImageMimeType("text/html")).toBe("image/png");
    expect(sanitizeImageMimeType("image/html;base64,x")).toBe("image/png");
    expect(sanitizeImageMimeType('image/png";onload="x')).toBe("image/png");
    expect(sanitizeImageMimeType(undefined)).toBe("image/png");
    expect(sanitizeImageMimeType(42)).toBe("image/png");
  });
});

describe("collectUserImageThumbs", () => {
  const resolvePath = (path: string): string | null =>
    path === "gone.png" ? null : `app://resource/${path}`;

  it("resolves vault image attachments to resource URLs", () => {
    expect(collectUserImageThumbs(["images/a.png"], undefined, resolvePath)).toEqual([
      { src: "app://resource/images/a.png", alt: "images/a.png", path: "images/a.png" },
    ]);
  });

  it("skips non-image attachments without dropping later images", () => {
    const attachments = [
      "notes/doc.md",
      { type: "text", id: "s", label: "sel", text: "hi" },
      "images/b.png",
    ] as unknown as Parameters<typeof collectUserImageThumbs>[0];
    expect(collectUserImageThumbs(attachments, undefined, resolvePath)).toEqual([
      { src: "app://resource/images/b.png", alt: "images/b.png", path: "images/b.png" },
    ]);
  });

  it("drops unresolvable images and survives resolver throws", () => {
    const throwing = (path: string): string | null => {
      if (path === "boom.png") throw new Error("vault gone");
      return resolvePath(path);
    };
    expect(collectUserImageThumbs(["gone.png", "boom.png", "ok.png"], undefined, throwing)).toEqual([
      { src: "app://resource/ok.png", alt: "ok.png", path: "ok.png" },
    ]);
  });

  it("strips query strings before lookup", () => {
    const seen: string[] = [];
    collectUserImageThumbs(["pic.png?v=2"], undefined, (path) => {
      seen.push(path);
      return `app://resource/${path}`;
    });
    expect(seen).toEqual(["pic.png"]);
  });

  it("renders history images as data URLs with sanitized mime types", () => {
    expect(
      collectUserImageThumbs([], [{ data: "aGk=", mimeType: "image/jpeg" }], resolvePath),
    ).toEqual([{ src: "data:image/jpeg;base64,aGk=", alt: "Attached image" }]);
    expect(collectUserImageThumbs([], [{ data: "aGk=", mimeType: "text/html" }], resolvePath)).toEqual([
      { src: "data:image/png;base64,aGk=", alt: "Attached image" },
    ]);
    expect(collectUserImageThumbs([], [{ data: "", mimeType: "image/png" }], resolvePath)).toEqual([]);
    expect(collectUserImageThumbs([], [{ data: "  ", mimeType: "image/png" }], resolvePath)).toEqual([]);
  });

  it("caps thumbnails across live and history sources", () => {
    const attachments = Array.from({ length: 10 }, (_, i) => `i${i}.png`);
    const thumbs = collectUserImageThumbs(attachments, [{ data: "aGk=", mimeType: "image/png" }], resolvePath, 8);
    expect(thumbs).toHaveLength(8);
    expect(collectUserImageThumbs([], Array.from({ length: 10 }, () => ({ data: "aGk=", mimeType: "image/png" })), resolvePath, 8)).toHaveLength(8);
  });
});
