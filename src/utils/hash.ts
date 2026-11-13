/**
 * 32-bit FNV-1a: a fast, non-cryptographic fingerprint for ids, dedup keys,
 * and drift checks. Use `sha256` when the hash must resist collisions.
 *
 * `codePoints` hashes Unicode code points instead of UTF-16 code units. The two
 * differ only for characters outside the BMP (emoji, some CJK). Callers whose
 * hashes are persisted keep the mode they shipped with, or stored values stop
 * matching.
 */
export function fnv1a32(value: string, options: { codePoints?: boolean } = {}): number {
  let hash = 0x811c9dc5;
  if (options.codePoints) {
    for (const char of value) {
      hash ^= char.codePointAt(0) ?? 0;
      hash = Math.imul(hash, 0x01000193);
    }
  } else {
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return hash >>> 0;
}
