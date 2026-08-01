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

/** 1-based line window actually served for a path at a given mtime. */
interface ServedWindow {
  start: number;
  end: number;
  /** The served slice covered the entire file. */
  full: boolean;
  content: string;
  mtime: number;
}

/** A requested read expressed as a 1-based line window. */
export interface RequestedWindow {
  path: string;
  start: number;
  /** Inclusive last line; meaningless when `toEnd` is set. */
  end: number;
  /** The request runs to the end of the file (no limit given). */
  toEnd: boolean;
}

/** The overlap between a requested range and what was served before, if any. */
export interface CoverageMatch {
  full: boolean;
  /** Previously served content covering the request, truncated for quoting. */
  quote: string;
}

const MAX_COVERAGE_QUOTE = 600;

export class ReadMemo {
  private readonly seen = new Set<string>();
  // TODO: contentCache may be redundant — same-session dedup already handled by
  // `seen`, and Obsidian's cachedRead is fast enough that cross-session
  // caching may not save measurable tokens or latency. Evaluate removing this
  // if profiling shows no benefit over a plain re-read.
  private readonly contentCache = new Map<string, CachedRead>();
  /** Line windows served per path, so a re-read of already-served lines can be pointed at the prior content. */
  private readonly coverage = new Map<string, ServedWindow[]>();

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
   * Record which 1-based lines were actually served, so later reads of the same
   * file at the same mtime can be deduped even when the range differs (B6).
   * `full` must be true only when the served slice covered the whole file.
   */
  recordCoverage(key: { path: string; startLine: number; endLine: number; content: string }, mtime: number, full: boolean): void {
    const windows = this.coverage.get(key.path) ?? [];
    windows.push({ start: key.startLine, end: key.endLine, full, content: key.content, mtime });
    this.coverage.set(key.path, windows);
  }

  /**
   * The requested line window has already been served for this path at this
   * mtime (either the exact lines, or a containing window). A request that runs
   * to the end of the file counts as covered only by a previous full read.
   */
  coverageFor(request: RequestedWindow, mtime: number): CoverageMatch | null {
    const windows = this.coverage.get(request.path) ?? [];
    let best: ServedWindow | null = null;
    for (const window of windows) {
      if (window.mtime !== mtime) continue;
      if (window.start > request.start) continue;
      if (request.toEnd ? !window.full : request.end > window.end) continue;
      // Prefer the tightest containing window so the quote is most relevant.
      if (!best || window.end - window.start < best.end - best.start) best = window;
    }
    if (!best) return null;
    const content =
      best.content.length > MAX_COVERAGE_QUOTE
        ? `${best.content.slice(0, MAX_COVERAGE_QUOTE)}\n…`
        : best.content;
    return { full: best.full, quote: content };
  }

  /** Cache the content of a successful read keyed by path, range and file mtime. */
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
    this.coverage.delete(path);
  }

  clear(): void {
    this.seen.clear();
    this.contentCache.clear();
    this.coverage.clear();
  }
}

/** The message returned in place of re-dumped content when a read is a memo hit. */
export function alreadyReadMessage(path: string): string {
  return (
    `You already read "${path}" earlier in this conversation — that content is above. ` +
    "Use a different startLine/endLine or offset/limit for another part, or grep if you only need a snippet."
  );
}

/** The message when the requested lines were already served (maybe as part of a wider range). */
export function coveredReadMessage(path: string, match: CoverageMatch): string {
  const scope = match.full
    ? "you already read the whole file"
    : "those lines are inside content you already read";
  const quote = match.quote ? `\n\nPreviously served content:\n${match.quote}` : "";
  return (
    `Re-reading "${path}" would only re-pull text you already have: ${scope} earlier in this conversation ` +
    "and the file has not changed. Use grep/search to locate a snippet, or read a range you have not seen yet." +
    quote
  );
}

/** Message prefix when a re-read is served from the harness-side cache. */
export function cachedReadMessage(path: string, since: number): string {
  const time = new Date(since).toISOString();
  return `Served from cache — "${path}" is unchanged since last read at ${time}.\n\n`;
}
