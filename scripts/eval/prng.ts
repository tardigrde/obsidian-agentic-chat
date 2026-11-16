/**
 * Seeded PRNG shared by the eval fixtures and the significance bootstrap.
 *
 * mulberry32: 32-bit state, one multiply and a few shifts per draw. The
 * sequence is fixed by the seed and stays the same across Node versions, so a
 * generated vault and a bootstrap interval are reproducible from the seed
 * alone.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}
