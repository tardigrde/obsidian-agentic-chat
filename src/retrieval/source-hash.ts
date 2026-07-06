const encoder = new TextEncoder();

export async function stableTextHash(input: string): Promise<string> {
  const subtle = window.crypto?.subtle;
  if (!subtle) throw new Error("SHA-256 hashing is unavailable on this platform.");
  const digest = await subtle.digest("SHA-256", encoder.encode(input));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function legacyStableTextHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}
