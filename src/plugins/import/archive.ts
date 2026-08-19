import { gunzipSync, unzipSync } from "../../vendor/fflate";

/**
 * Relative file tree extracted from a source archive, keyed by normalized
 * forward-slash paths. Directories are not stored (they are implicit).
 */
export type FileTree = Map<string, Uint8Array>;

/** Hard caps applied while spreading an archive, so a hostile archive can't exhaust memory. */
export const ARCHIVE_LIMITS = {
  maxEntries: 10_000,
  totalBytes: 256 * 1024 * 1024,
  singleFileBytes: 64 * 1024 * 1024,
} as const;

export type ArchiveKind = "zip" | "tar.gz";

/**
 * Normalize and vet a path extracted from an archive. Returns null when the
 * path is unsafe (absolute, parent-traversal, drive-qualified, empty, or a
 * directory marker); backslashes are normalized to forward slashes because
 * some ZIP creators use Windows separators.
 */
export function safeArchivePath(raw: string): string | null {
  let path = raw.replace(/\\/g, "/").trim();
  while (path.startsWith("./")) path = path.slice(2);
  if (!path || path.endsWith("/") || path.includes("/./")) return null;
  if (path.startsWith("/") || path.includes("/../") || path === ".." || path.startsWith("../") || /^[A-Za-z]:/.test(path)) {
    return null;
  }
  for (let index = 0; index < path.length; index += 1) {
    const code = path.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return null;
  }
  return path;
}

/** Extract a ZIP archive into a guarded file tree. */
export function extractZip(bytes: Uint8Array): FileTree {
  const trees: FileTree = new Map();
  let total = 0;
  let accepted = 0;
  const unzipped = unzipSync(bytes, {
    filter: (entry) => {
      const path = safeArchivePath(entry.name);
      if (path === null || entry.originalSize > ARCHIVE_LIMITS.singleFileBytes) return false;
      total += entry.originalSize;
      const ok = total <= ARCHIVE_LIMITS.totalBytes && accepted < ARCHIVE_LIMITS.maxEntries;
      if (ok) accepted += 1;
      return ok;
    },
  });
  for (const [rawPath, content] of Object.entries(unzipped)) {
    const path = safeArchivePath(rawPath);
    if (path) trees.set(path, content);
  }
  return trees;
}

/**
 * Decompress a gzipped tarball into a guarded file tree. Reads the gzip
 * trailer's ISIZE field (uncompressed length, little-endian, minus the 18-byte
 * header/trailer minimum) to reject bombs before inflation; the inflated
 * length is checked again as a backstop. Handles ustar/GNU (long-name 'L'
 * headers) and pax ('x' path= records) layouts, skips symlinks/hardlinks/
 * directories, and ignores all path metadata safely.
 */
export function extractTarGz(bytes: Uint8Array): FileTree {
  if (bytes.length >= 18) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + bytes.byteLength - 4, 4);
    if (view.getUint32(0, true) > ARCHIVE_LIMITS.totalBytes) {
      throw new Error(`Refusing archive that claims to expand beyond ${ARCHIVE_LIMITS.totalBytes} bytes.`);
    }
  }
  const inflated = gunzipSync(bytes);
  if (inflated.length > ARCHIVE_LIMITS.totalBytes) {
    throw new Error(`Archive expands beyond ${ARCHIVE_LIMITS.totalBytes} bytes.`);
  }
  return parseTar(inflated);
}

/** Extract an archive whose kind is known from the source URL. */
export function extractArchive(bytes: Uint8Array, kind: ArchiveKind): FileTree {
  return kind === "zip" ? extractZip(bytes) : extractTarGz(bytes);
}

/** True when the archive bytes look gzip-compressed (1f 8b magic). */
export function looksGzip(bytes: Uint8Array): boolean {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/** True when the bytes look like a ZIP archive (PK.. magic). */
export function looksZip(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

const TEXT_DECODER = new TextDecoder("utf-8");

function parseTar(data: Uint8Array): FileTree {
  const files: FileTree = new Map();
  let offset = 0;
  let pendingName: string | null = null;
  let total = 0;
  while (offset + 512 <= data.length && files.size <= ARCHIVE_LIMITS.maxEntries) {
    const header = data.subarray(offset, offset + 512);
    if (isZeroBlock(header)) break;
    const rawName = headerText(header, 0, 100);
    if (!rawName) break;
    const size = parseOctal(headerText(header, 124, 12));
    if (!Number.isFinite(size) || size < 0) break;
    const dataStart = offset + 512;
    if (dataStart + size > data.length) break;
    const type = header[156];
    const prefix = headerText(header, 345, 155) || "";
    // Oversized single entries are skipped, not fatal: codeload tarballs list
    // entries alphabetically, so a large asset (e.g. assets/huge.bin) can
    // precede plugin.json and must not abort the whole parse. Bomb protection
    // is still enforced via the cumulative total below.
    if (size > ARCHIVE_LIMITS.singleFileBytes) {
      offset = dataStart + Math.ceil(size / 512) * 512;
      continue;
    }
    if (type === 0x4c) {
      pendingName = headerText(data, dataStart, size) || null;
    } else if (type === 0x78 || type === 0x67) {
      const paxPath = paxRecordPath(data, dataStart, size);
      if (paxPath) pendingName = paxPath;
    } else {
      const name = pendingName ?? (prefix ? `${prefix}/${rawName}` : rawName);
      pendingName = null;
      if (type === 0x00 || type === 0x30) {
        const path = safeArchivePath(name);
        if (path && size > 0 && !files.has(path)) {
          total += size;
          if (total > ARCHIVE_LIMITS.totalBytes) break;
          files.set(path, data.subarray(dataStart, dataStart + size));
        }
      }
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return files;
}

function isZeroBlock(block: Uint8Array): boolean {
  return block.every((byte) => byte === 0);
}

/** Decode an ASCII substring of a header block, trimmed at the first NUL. */
function headerText(block: Uint8Array, start: number, length: number): string {
  return TEXT_DECODER.decode(block.subarray(start, start + length)).split("\0", 1)[0] ?? "";
}

/** Octal size field: numeric digits up to the first NUL or space. */
function parseOctal(field: string): number {
  const digits = field.trim();
  if (!digits) return Number.NaN;
  if (/^[0-7]+$/.test(digits)) return Number.parseInt(digits, 8);
  // Some writers store decimal sizes (e.g. pax-translated tars).
  if (/^\d+$/.test(digits)) return Number.parseInt(digits, 10);
  return Number.NaN;
}

/** Extract the `path=` value (UTF-8) from a pax extended header record block. */
function paxRecordPath(block: Uint8Array, start: number, size: number): string | null {
  const records = TEXT_DECODER.decode(block.subarray(start, start + size));
  for (const record of records.split("\n")) {
    const match = /^\d+ path=(.*)$/.exec(record);
    if (match) return match[1];
  }
  return null;
}