import { describe, expect, it } from "vitest";
import {
  KEEP_IMAGE_BYTES,
  MAX_IMAGE_SIDE,
  shrinkImageForModel,
  targetImageSize,
  type ImageCodec,
} from "../src/ui/image-shrink";

/**
 * U5 #8: images are shrunk before base64, so the request and the session file
 * get the small copy. happy-dom has no canvas, so a fake codec stands in; the
 * fake returns encoded blobs of a chosen size and records each encode call.
 */
function fakeCodec(width: number, height: number, sizes: (type: string, quality?: number) => number | null) {
  const calls: Array<{ width: number; height: number; type: string; quality?: number }> = [];
  let closed = 0;
  const codec: ImageCodec = async () => ({
    width,
    height,
    encode: async (w, h, type, quality) => {
      calls.push({ width: w, height: h, type, quality });
      const size = sizes(type, quality);
      return size === null ? null : new Blob([new Uint8Array(size)], { type });
    },
    close: () => {
      closed += 1;
    },
  });
  return { codec, calls, closed: () => closed };
}

const bytes = (n: number): ArrayBuffer => new Uint8Array(n).buffer;

describe("targetImageSize", () => {
  it("keeps an image within the side limit and scales a larger one to the limit", () => {
    expect(targetImageSize(1070, 1335)).toEqual({ width: 1070, height: 1335 });
    expect(targetImageSize(4000, 3000)).toEqual({ width: MAX_IMAGE_SIDE, height: 1500 });
    expect(targetImageSize(3000, 6000)).toEqual({ width: 1000, height: MAX_IMAGE_SIDE });
  });
});

describe("shrinkImageForModel", () => {
  it("sends the owner's 2 MB PNG photo (1070x1335) as a much smaller JPEG at the same size", async () => {
    const fake = fakeCodec(1070, 1335, (type) => (type === "image/png" ? 2_000_000 : 300_000));
    const result = await shrinkImageForModel(bytes(2_000_000), "image/png", fake.codec);
    expect(result).toMatchObject({ mimeType: "image/jpeg", changed: true });
    expect(result.data.byteLength).toBe(300_000);
    expect(fake.calls[0]).toMatchObject({ type: "image/png", width: 1070, height: 1335 });
    expect(fake.calls[1]).toMatchObject({ type: "image/jpeg", quality: 0.85 });
    expect(fake.closed()).toBe(1);
  });

  it("keeps a screenshot as PNG when the PNG at the target size is small", async () => {
    const fake = fakeCodec(3840, 2160, () => 800_000);
    const result = await shrinkImageForModel(bytes(3_000_000), "image/png", fake.codec);
    expect(result).toMatchObject({ mimeType: "image/png", changed: true });
    expect(fake.calls).toEqual([{ width: 2000, height: 1125, type: "image/png", quality: undefined }]);
  });

  it("sends a small image within the side limit unchanged, without an encode", async () => {
    const fake = fakeCodec(800, 600, () => 10);
    const source = bytes(KEEP_IMAGE_BYTES);
    const result = await shrinkImageForModel(source, "image/jpeg", fake.codec);
    expect(result).toEqual({ data: source, mimeType: "image/jpeg", changed: false });
    expect(fake.calls).toEqual([]);
  });

  it("lowers the JPEG quality until the base64 payload fits 5 MiB", async () => {
    const fake = fakeCodec(6000, 4000, (_type, quality) => (quality === 0.85 ? 5_000_000 : 3_000_000));
    const result = await shrinkImageForModel(bytes(9_000_000), "image/jpeg", fake.codec);
    expect(result).toMatchObject({ mimeType: "image/jpeg", changed: true });
    expect(fake.calls.map((call) => call.quality)).toEqual([0.85, 0.7]);
    expect(fake.calls[0]).toMatchObject({ width: 2000, height: 1333 });
  });

  it("keeps the original when a re-encode within the side limit is not smaller", async () => {
    const fake = fakeCodec(1500, 1000, () => 1_500_000);
    const source = bytes(1_200_000);
    const result = await shrinkImageForModel(source, "image/jpeg", fake.codec);
    expect(result).toEqual({ data: source, mimeType: "image/jpeg", changed: false });
  });

  it("never re-encodes a GIF (it can be animated)", async () => {
    const fake = fakeCodec(4000, 4000, () => 10);
    const source = bytes(3_000_000);
    expect(await shrinkImageForModel(source, "image/gif", fake.codec)).toEqual({ data: source, mimeType: "image/gif", changed: false });
    expect(fake.calls).toEqual([]);
  });

  it("sends the original when the platform cannot decode or the decode throws", async () => {
    const source = bytes(3_000_000);
    expect(await shrinkImageForModel(source, "image/png", async () => null)).toMatchObject({ data: source, changed: false });
    const throwing: ImageCodec = async () => {
      throw new Error("bad image");
    };
    expect(await shrinkImageForModel(source, "image/png", throwing)).toMatchObject({ data: source, changed: false });
  });
});
