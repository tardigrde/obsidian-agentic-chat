/**
 * Shrink an image attachment before it goes to the model (U5 #8). The base64
 * copy also goes into the session file, so a 2 MB PNG made 96% of one session
 * and slowed the next model call. Providers downscale large images anyway
 * (about 1568 to 2048 px on the long side), so a bigger image costs bytes and
 * time and adds nothing.
 *
 * Rules: the long side is at most {@link MAX_IMAGE_SIDE} px. A small image is
 * sent as is. A PNG (often a screenshot with text) stays PNG when the PNG is
 * small enough; otherwise the image becomes a JPEG. GIFs are never re-encoded
 * (they can be animated). Any failure (no canvas, a decode error) sends the
 * original bytes, so the shrink can only help.
 */

/** Long side limit in px. */
export const MAX_IMAGE_SIDE = 2000;
/** An image at most this many bytes, within the side limit, is sent unchanged. */
export const KEEP_IMAGE_BYTES = 1_000_000;
/** Upper bound for the base64 payload of one image (5 MiB). */
export const MAX_IMAGE_BASE64_BYTES = 5 * 1024 * 1024;
/** JPEG qualities, tried in order until the payload fits. */
export const JPEG_QUALITIES = [0.85, 0.7, 0.55, 0.4] as const;

export interface DecodedImage {
  width: number;
  height: number;
  /** Draw at `width` x `height` and encode; null when the encode fails. */
  encode(width: number, height: number, mimeType: string, quality?: number): Promise<Blob | null>;
  close(): void;
}

/** Decodes image bytes; null when this platform cannot decode them. */
export type ImageCodec = (blob: Blob) => Promise<DecodedImage | null>;

export interface ShrunkImage {
  data: ArrayBuffer;
  mimeType: string;
  /** False when the original bytes are returned. */
  changed: boolean;
}

/** The target size for an image: scaled so the long side is at most {@link MAX_IMAGE_SIDE}. */
export function targetImageSize(width: number, height: number): { width: number; height: number } {
  const longSide = Math.max(width, height);
  if (longSide <= MAX_IMAGE_SIDE) return { width, height };
  const scale = MAX_IMAGE_SIDE / longSide;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

const base64Length = (bytes: number): number => Math.ceil(bytes / 3) * 4;

export async function shrinkImageForModel(
  data: ArrayBuffer,
  mimeType: string,
  codec: ImageCodec = browserImageCodec,
): Promise<ShrunkImage> {
  const original: ShrunkImage = { data, mimeType, changed: false };
  if (mimeType === "image/gif") return original;
  let image: DecodedImage | null = null;
  try {
    image = await codec(new Blob([data], { type: mimeType }));
    if (!image || image.width <= 0 || image.height <= 0) return original;
    const size = targetImageSize(image.width, image.height);
    const resized = size.width !== image.width || size.height !== image.height;
    if (!resized && data.byteLength <= KEEP_IMAGE_BYTES) return original;

    if (mimeType === "image/png") {
      const png = await image.encode(size.width, size.height, "image/png");
      if (png && png.size <= KEEP_IMAGE_BYTES) return await result(png, "image/png", data, resized);
    }
    for (const quality of JPEG_QUALITIES) {
      const jpeg = await image.encode(size.width, size.height, "image/jpeg", quality);
      if (!jpeg) break;
      if (base64Length(jpeg.size) <= MAX_IMAGE_BASE64_BYTES) return await result(jpeg, "image/jpeg", data, resized);
    }
    return original;
  } catch {
    return original;
  } finally {
    image?.close();
  }

  async function result(blob: Blob, type: string, source: ArrayBuffer, resized: boolean): Promise<ShrunkImage> {
    // A re-encode that is not smaller, and not needed for the side limit, is no gain.
    if (!resized && blob.size >= source.byteLength) return original;
    return { data: await blob.arrayBuffer(), mimeType: type, changed: true };
  }
}

/**
 * The real codec: `createImageBitmap` plus a canvas. Both exist in Obsidian
 * desktop (Electron) and mobile (the system web view). JPEG has no alpha, so
 * the canvas is filled white first; a transparent PNG must not turn black.
 */
export const browserImageCodec: ImageCodec = async (blob) => {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return null;
  const bitmap = await createImageBitmap(blob);
  return {
    width: bitmap.width,
    height: bitmap.height,
    encode: async (width, height, mimeType, quality) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) return null;
      if (mimeType === "image/jpeg") {
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, width, height);
      }
      context.imageSmoothingQuality = "high";
      context.drawImage(bitmap, 0, 0, width, height);
      return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mimeType, quality));
    },
    close: () => bitmap.close(),
  };
};
