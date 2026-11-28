/**
 * Fingerprints (`length:fnv1a`) of every default system prompt a release
 * shipped. The removed `systemPrompt` setting stored the whole default in
 * data.json, so an upgrade must not report an old default as a custom prompt.
 * The list is frozen: no later build writes the setting.
 */
const SHIPPED_PROMPT_FINGERPRINTS: ReadonlySet<string> = new Set([
  "598:ca5d12a1",
  "714:2c309b30",
  "1555:854dfdc4",
  "1540:c7be5328",
  "2179:85d4018f",
  "2379:69731853",
  "2395:c74415ba",
  "2772:7f0c3b2c",
  "2950:b8facaf2",
  "3006:e49ac66f",
  "3026:76a26cc0",
  "3100:23706b90",
  "3251:f1847315",
]);

function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
  }
  return `${text.length}:${hash.toString(16).padStart(8, "0")}`;
}

/** True when `prompt` is a default some release shipped, not the user's own text. */
export function isShippedSystemPrompt(prompt: string): boolean {
  return SHIPPED_PROMPT_FINGERPRINTS.has(fingerprint(prompt.replace(/\r\n/g, "\n").trim()));
}
