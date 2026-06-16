/**
 * Pure helpers for vision (image) attachments. Kept separate from `chat-view` so
 * they're unit-testable without the Obsidian UI, and reused by the chip rendering
 * and the outgoing-message image encoding.
 */

/** Vault image extensions an OpenRouter vision model can read. */
export const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

/** True when an attachment path points at an image file (by extension). */
export function isImagePath(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTENSIONS.has(ext);
}

/** MIME type for an image file extension (defaults to PNG for unknown). */
export function imageMimeType(ext: string): string {
  switch (ext.toLowerCase()) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "png":
    default:
      return "image/png";
  }
}

/**
 * Base64-encode binary image data in chunks. The chunk is small (4 KiB) so the
 * `String.fromCharCode(...chunk)` spread can't blow the call stack on engines with
 * a low argument cap (notably iOS JavaScriptCore) when encoding a large image.
 */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x1000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
