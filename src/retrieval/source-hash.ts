import { fnv1a32 } from "../utils/hash";
const encoder = new TextEncoder();

export async function stableTextHash(input: string): Promise<string> {
  const subtle = window.crypto?.subtle;
  if (!subtle) throw new Error("SHA-256 hashing is unavailable on this platform.");
  const digest = await subtle.digest("SHA-256", encoder.encode(input));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function legacyStableTextHash(input: string): string {
  return fnv1a32(input).toString(36);
}
