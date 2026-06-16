import { describe, expect, it } from "vitest";
import { arrayBufferToBase64, imageMimeType, isImagePath } from "../src/ui/image-attachments";

describe("image-attachments", () => {
  it("detects image paths by extension, case-insensitively", () => {
    expect(isImagePath("Attachments/diagram.png")).toBe(true);
    expect(isImagePath("photo.JPG")).toBe(true);
    expect(isImagePath("clip.webp")).toBe(true);
    expect(isImagePath("note.md")).toBe(false);
    expect(isImagePath("README")).toBe(false);
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
});
