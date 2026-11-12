export async function createPkce(randomBytes: ((size: number) => Uint8Array) | undefined): Promise<{
  verifier: string;
  challenge: string;
}> {
  const verifier = base64UrlEncode((randomBytes ?? defaultRandomBytes)(32));
  const challenge = await sha256Base64Url(verifier);
  return { verifier, challenge };
}

async function sha256Base64Url(input: string): Promise<string> {
  const subtle = window.crypto?.subtle;
  if (!subtle) throw new Error("Web Crypto is required for MCP OAuth PKCE.");
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(input));
  return base64UrlEncode(new Uint8Array(digest));
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCodePoint(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

export function defaultRandomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  window.crypto.getRandomValues(bytes);
  return bytes;
}
