/**
 * Bound a WebDriver call against a frozen Obsidian. A script that never
 * returns would otherwise block the run until mocha's timeout, past every cap.
 */

/** Obsidian stopped answering WebDriver: end the run, do not wait for mocha. */
export class DriverHang extends Error {}

export async function withHangTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hang = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DriverHang(`${what} got no answer from Obsidian in ${Math.round(ms / 1000)}s`)), ms);
  });
  try {
    return await Promise.race([work, hang]);
  } finally {
    clearTimeout(timer);
  }
}
