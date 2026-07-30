/**
 * De-duplication memo + content cache for the `read` tool.
 *
 * The `seen` set prevents re-injecting the exact same range twice in one
 * turn (dedup). The `contentCache` stores the actual file text keyed by
 * (path, range, mtime) so that *re-reads* after compaction can be served
 * from cache when the file has not changed on disk.
 *
 * A read is only recorded after its content is successfully returned, so a
 * failed or refused read never poisons the cache.
 */
export interface ReadKey {
  path: string;
  offset?: number;
  limit?: number;
  startLine?: number;
  endLine?: number;
}

/** Stable identity for a read: the path plus the (optional) line window. */
export function readKey(key: ReadKey): string {
  return `${key.path}\u0000${key.offset ?? ""}\u0000${key.limit ?? ""}`;
}

interface CachedRead {
  mtime: number;
  content: string;
  timestamp: number;
}

export class ReadMemo {
  private readonly seen = new Set<string>();
  // TODO: contentCache may be redundant — same-session dedup already handled by
  // `seen`, and Obsidian's cachedRead is fast enough that cross-session
  // caching may not save measurable tokens or latency. Evaluate removing this
  // if profiling shows no benefit over a plain re-read.
  private readonly contentCache = new Map<string, CachedRead>();

  /** Whether this exact (path, range) was already served this session. */
  has(key: ReadKey): boolean {
    return this.seen.has(readKey(key));
  }

  /**
   * Record a read as served. Call only after content was successfully returned,
   * never speculatively — a read that errors or is refused must not be marked,
   * or the next identical read would get a stale pointer.
   */
  mark(key: ReadKey): void {
    this.seen.add(readKey(key));
  }

  /**
   * Cache the content of a successful read keyed by path, range and file mtime.
   * Returns the cached entry so the caller can build a "served from cache" message.
   */
  cache(key: ReadKey, mtime: number, content: string): void {
    this.contentCache.set(readKey(key), { mtime, content, timestamp: Date.now() });
  }

  /** Return cached content when the key and mtime both match; otherwise null. */
  getCached(key: ReadKey, mtime: number): CachedRead | null {
    const entry = this.contentCache.get(readKey(key));
    if (!entry || entry.mtime !== mtime) return null;
    return entry;
  }

  /** Drop every memoized read and cached content of `path`. */
  invalidate(path: string): void {
    const prefix = `${path}\u0000`;
    for (const id of this.seen) {
      if (id.startsWith(prefix)) this.seen.delete(id);
    }
    for (const [id] of this.contentCache) {
      if (id.startsWith(prefix)) this.contentCache.delete(id);
    }
  }

  clear(): void {
    this.seen.clear();
    this.contentCache.clear();
  }
}

/** The message returned in place of re-dumped content when a read is a memo hit. */
export function alreadyReadMessage(path: string): string {
  return (
    `You already read "${path}" earlier in this conversation — that content is above. ` +
    "Use a different startLine/endLine or offset/limit for another part, or grep if you only need a snippet."
  );
}

/** Message prefix when a re-read is served from the harness-side cache. */
export function cachedReadMessage(path: string, since: number): string {
  const time = new Date(since).toISOString();
  return `Served from cache — "${path}" is unchanged since last read at ${time}.\n\n`;
}
