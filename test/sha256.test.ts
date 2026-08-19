import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/utils/sha256";

describe("sha256Hex", () => {
  it("matches FIPS 180-4 vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("The quick brown fox jumps over the lazy dog")).toBe(
      "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592",
    );
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
    expect(sha256Hex("a".repeat(1000))).toBe(
      "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3",
    );
  });

  it("handles non-ASCII input deterministically", () => {
    const emoji = sha256Hex("😀");
    expect(emoji).toBe(sha256Hex("😀"));
    expect(emoji).not.toBe(sha256Hex("\ud83d"));
    expect(emoji).toHaveLength(64);
  });
});
