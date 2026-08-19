import { requestUrl } from "obsidian";
import { extractArchive, looksGzip, looksZip, type ArchiveKind, type FileTree } from "./archive";

/**
 * Where an importable package lives, per the accepted URL grammar:
 *   - `owner/repo`                    (GitHub shorthand, default branch)
 *   - https://github.com/owner/repo   (repository snapshot)
 *   - https://github.com/owner/repo/tree/<ref>[/path...]
 *   - https://github.com/owner/repo/blob/<ref>/<path...>
 *   - https://github.com/owner/repo/raw/<ref>/<path...>
 *   - https://raw.githubusercontent.com/owner/repo/<ref>/<path...>
 *   - https://github.com/owner/repo/archive/<...>.zip|.tar.gz
 *   - https://codeload.github.com/owner/repo/{zip,tar.gz}/<ref>
 *   - any http(s) URL ending in .zip/.tar.gz/.tgz
 * Anything else is rejected with an explicit reason, never silently misread.
 */
export type ParsedImportSource =
  | { kind: "github"; owner: string; repo: string; ref?: string; path?: string; remainder?: string; mode?: "tree" | "blob" | "raw" }
  | { kind: "archive-url"; url: string; kindHint?: ArchiveKind };

export function parseImportSource(input: string): { parsed: ParsedImportSource } | { error: string } {
  const trimmed = input.trim().replace(/[?#].*$/, "");
  if (!trimmed) return { error: "Enter a GitHub URL or repository shorthand (owner/repo)." };

  const shorthand = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(trimmed);
  if (shorthand) {
    return {
      parsed: { kind: "github", owner: shorthand[1], repo: shorthand[2] },
    };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { error: `"${trimmed}" is not a valid URL. Use https://github.com/owner/repo or owner/repo.` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { error: `Only http(s) URLs can be imported, got "${url.protocol}" for ${trimmed}.` };
  }

  const host = url.hostname.toLowerCase();
  if (host === "github.com") {
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length >= 2) {
      const owner = segments[0];
      const repo = segments[1];
      const rest = segments.slice(2);
      if (rest.length === 0) return { parsed: { kind: "github", owner, repo } };
      const mode = rest[0];
      // Direct archive links (e.g. /releases/download/v1.0/pkg.zip) are valid
      // import sources even though they are not /tree /blob /raw /archive.
      if (mode !== "tree" && mode !== "blob" && mode !== "raw") {
        const hint = archiveKindFromPath(url.pathname);
        if (hint) return { parsed: { kind: "archive-url", url: url.toString(), kindHint: hint } };
      }
      const refAndPath = rest.slice(1).join("/");
      if (mode === "tree") {
        if (!refAndPath) return { parsed: { kind: "github", owner, repo } };
        const [ref, ...pathParts] = refAndPath.split("/");
        return {
          parsed: {
            kind: "github",
            owner,
            repo,
            ref,
            path: pathParts.join("/") || undefined,
            remainder: refAndPath,
            mode: "tree",
          },
        };
      }
      if (mode === "blob" || mode === "raw") {
        const [ref, ...pathParts] = refAndPath.split("/");
        if (!ref || pathParts.length === 0) {
          return { error: `GitHub "${mode}" URLs must include a ref and a file path (${trimmed}).` };
        }
        return {
          parsed: { kind: "github", owner, repo, ref, path: pathParts.join("/"), remainder: refAndPath, mode },
        };
      }
      if (mode === "archive") {
        return archiveHintFromUrl(url.toString()) ?? {
          error: `GitHub archive URLs must end in .zip, .tar.gz, or .tgz (${trimmed}).`,
        };
      }
      return {
        error: `Unknown GitHub URL shape "${mode}" in ${trimmed}. Supported: owner/repo, /tree/<ref>[/path], /blob/<ref>/<path>, /archive/<...>.zip|.tar.gz, and direct archive links.`,
      };
    }
    return { error: `A GitHub URL must include at least owner and repository (${trimmed}).` };
  }

  if (host === "raw.githubusercontent.com") {
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length < 4) {
      return {
        error: `raw.githubusercontent.com URLs must be owner/repo/<ref>/<path...> (${trimmed}).`,
      };
    }
    const [owner, repo, ...rest] = segments;
    return {
      parsed: { kind: "github", owner, repo, ref: rest[0], path: rest.slice(1).join("/"), remainder: rest.join("/") },
    };
  }

  if (host === "codeload.github.com") {
    const segments = url.pathname.split("/").filter(Boolean);
    const [owner, repo, kind, ref, ...rest] = segments;
    if (!owner || !repo || !kind || !ref || rest.length > 0) {
      return { error: `codeload.github.com URLs must be owner/repo/{zip|tar.gz}/<ref> (${trimmed}).` };
    }
    if (kind !== "zip" && kind !== "tar.gz") {
      return { error: `Unknown codeload archive kind "${kind}"; expected zip or tar.gz (${trimmed}).` };
    }
    return { parsed: { kind: "archive-url", url: url.toString(), kindHint: kind } };
  }

  const hint = archiveKindFromPath(url.pathname);
  if (hint) return { parsed: { kind: "archive-url", url: url.toString(), kindHint: hint } };

  const hostLabel = host || "(no host)";
  return {
    error:
      `"${hostLabel}" is not a supported source. Import from GitHub (owner/repo or a ` +
      `github.com URL) or from a direct http(s) link to a .zip/.tar.gz/.tgz archive.`,
  };
}

function archiveHintFromUrl(url: string): { parsed: { kind: "archive-url"; url: string; kindHint?: ArchiveKind } } | null {
  const parsed = new URL(url);
  const hint = archiveKindFromPath(parsed.pathname);
  return hint ? { parsed: { kind: "archive-url", url, kindHint: hint } } : null;
}

function archiveKindFromPath(pathname: string): ArchiveKind | undefined {
  if (/\.zip$/i.test(pathname)) return "zip";
  if (/\.(tar\.gz|tgz)$/i.test(pathname)) return "tar.gz";
  return undefined;
}

/** Fetcher used by URL imports; production wraps Obsidian's requestUrl. */
export interface ImportBytesFetcher {
  fetchBytes(url: string): Promise<{ status: number; bytes: Uint8Array | undefined; contentType: string | undefined }>;
}

/** Production byte fetcher over Obsidian's `requestUrl` (mobile-safe, no CORS). */
export function createObsidianBytesFetcher(): ImportBytesFetcher {
  const fetcher: ImportBytesFetcher = {
    fetchBytes: async (url: string) => {
      const response = await requestUrl({ url, throw: false });
      let bytes: Uint8Array | undefined;
      try {
        if (response.arrayBuffer) bytes = new Uint8Array(response.arrayBuffer);
      } catch {
        bytes = undefined;
      }
      const headers = response.headers ?? {};
      return {
        status: response.status,
        bytes,
        contentType: typeof headers["content-type"] === "string" ? headers["content-type"] : undefined,
      };
    },
  };
  return fetcher;
}

export interface ResolvedSource {
  /** File tree with any single top-level wrapper directory stripped. */
  tree: FileTree;
  /** Human label for the installed package ("github:owner/repo", the URL, ...). */
  label: string;
}

/**
 * Turn a parsed source into a file tree. GitHub repo/tree sources download a
 * codeload tarball; file sources fetch one raw file via raw.githubusercontent.com.
 */
export async function resolveImportSource(
  parsed: ParsedImportSource,
  fetcher: ImportBytesFetcher,
): Promise<ResolvedSource> {
  if (parsed.kind === "archive-url") {
    const response = await fetcher.fetchBytes(parsed.url);
    assertSuccess(response, parsed.url);
    const bytes = response.bytes;
    if (!bytes || bytes.length === 0) {
      throw new Error(`Could not download ${parsed.url} (HTTP ${response.status ?? 0}).`);
    }
    return { tree: extractArchives(bytes, parsed.kindHint), label: parsed.url };
  }

  const { owner, repo } = parsed;
  if (parsed.path && parsed.mode !== "tree") {
    // raw.githubusercontent.com/<owner>/<repo>/<ref>/<path> resolves the ref by
    // the longest matching branch/tag prefix server-side, so the ref/path split
    // does not affect the fetched URL — a single fetch suffices.
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${parsed.remainder ?? `${parsed.ref}/${parsed.path}`}`;
    const response = await fetcher.fetchBytes(rawUrl);
    assertSuccess(response, rawUrl);
    const bytes = response.bytes;
    if (!bytes || bytes.length === 0) {
      throw new Error(`Could not download ${rawUrl} (HTTP ${response.status ?? 0}).`);
    }
    const relPath = parsed.path.split("/").pop() ?? "SKILL.md";
    const tree: FileTree = new Map([[relPath, bytes]]);
    return { tree, label: `github:${owner}/${repo}` };
  }

  // Repository snapshot (optionally under a subfolder): download the codeload
  // tarball for the longest matching ref, falling back to shorter refs so
  // branch/tag names containing slashes (e.g. /tree/feature/foo/skills) are
  // not misparsed into a 404.
  const tarballCandidates = refPathCandidates(parsed.remainder ?? parsed.ref ?? "HEAD");
  let lastStatus: number | undefined;
  for (const candidate of tarballCandidates) {
    const tarballUrl = `https://codeload.github.com/${owner}/${repo}/tar.gz/${candidate.ref}`;
    const response = await fetcher.fetchBytes(tarballUrl);
    lastStatus = response.status;
    if (response.status !== undefined && (response.status < 200 || response.status >= 300)) continue;
    const bytes = response.bytes;
    if (!bytes || bytes.length === 0) continue;
    let tree = extractArchive(bytes, "tar.gz");
    tree = stripSingleTopLevelDir(tree);
    if (candidate.path) tree = keepSubtree(tree, candidate.path);
    return { tree, label: `github:${owner}/${repo}` };
  }
  throw new Error(`Could not download a snapshot of ${owner}/${repo} (HTTP ${lastStatus ?? 0}).`);
}

/**
 * All (ref, path) splits of a GitHub tree remainder, ordered by the longest
 * ref first to match GitHub's own longest-prefix resolution (branches and
 * tags may contain slashes, e.g. feature/foo).
 */
function refPathCandidates(remainder: string): Array<{ ref: string; path?: string }> {
  const parts = remainder.split("/").filter(Boolean);
  const candidates: Array<{ ref: string; path?: string }> = [];
  for (let refLen = parts.length; refLen >= 1; refLen -= 1) {
    const path = parts.slice(refLen).join("/") || undefined;
    candidates.push({ ref: parts.slice(0, refLen).join("/"), path });
  }
  return candidates;
}

/** Reject non-2xx HTTP answers (404 pages would otherwise install as content). */
function assertSuccess(response: { status?: number }, url: string): void {
  if (response.status !== undefined && (response.status < 200 || response.status >= 300)) {
    throw new Error(`Could not download ${url} (HTTP ${response.status}).`);
  }
}

/** Strip the single leading directory (owner-repo-<sha>) GitHub archives add. */
export function stripSingleTopLevelDir(tree: FileTree): FileTree {
  const first = [...tree.keys()][0];
  const slash = first ? first.indexOf("/") : -1;
  if (slash === -1) return tree;
  const top = first.slice(0, slash);
  const stripped: FileTree = new Map();
  for (const [path, bytes] of tree) {
    if (path === top) continue;
    if (path.startsWith(`${top}/`)) stripped.set(path.slice(slash + 1), bytes);
    else return tree;
  }
  return stripped;
}

/** Keep only files under `prefix`, re-rooted at the prefix boundary. */
function keepSubtree(tree: FileTree, prefix: string): FileTree {
  const rooted = prefix.replace(/\/+$/, "") + "/";
  const subtree: FileTree = new Map();
  for (const [path, bytes] of tree) {
    if (path.startsWith(rooted)) subtree.set(path.slice(rooted.length), bytes);
  }
  return subtree;
}

/** Extract with kind detection (zip magic / gzip magic) when the URL was ambiguous. */
function extractArchives(bytes: Uint8Array, hint?: ArchiveKind): FileTree {
  if (hint === "zip" || (!hint && looksZip(bytes))) return extractArchive(bytes, "zip");
  if (hint === "tar.gz" || looksGzip(bytes)) return extractArchive(bytes, "tar.gz");
  throw new Error("The downloaded file is not a ZIP or tar.gz archive.");
}