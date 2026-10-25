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

/** Windows reserved device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9). */
const WINDOWS_RESERVED_BASE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Normalize and vet a path extracted from an archive. Returns null when the
 * path is unsafe (absolute, parent-traversal, drive-qualified, empty, or a
 * directory marker); backslashes are normalized to forward slashes because
 * some ZIP creators use Windows separators. Any single segment that is `.` or
 * `..`, ends in a dot or space, or is a Windows reserved device name is also
 * rejected, so odd-but-passing paths can never escape or collide weirdly.
 */
export function safeArchivePath(raw: string): string | null {
  let path = raw.replace(/\\/g, "/").trim();
  while (path.startsWith("./")) path = path.slice(2);
  if (!path || path.endsWith("/") || path.includes("/./")) return null;
  if (path.startsWith("/") || path.includes("/../") || path === ".." || path.startsWith("../") || /^[A-Za-z]:/.test(path)) {
    return null;
  }
  // Any single segment that is `.` or `..`, ends in a dot or space, or is a
  // Windows reserved device name is also rejected. These are valid names on
  // Linux/macOS, but an installed package may be synced to a Windows vault
  // where they break or shadow devices — a deliberate cross-platform safety
  // tradeoff for names that are vanishingly rare in real packages.
  for (const segment of path.split("/")) {
    if (!segment || segment === "." || segment === "..") return null;
    if (/[. ]$/.test(segment)) return null;
    if (WINDOWS_RESERVED_BASE.test(segment)) return null;
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

const TAR_BLOCK_BYTES = 512;

/** One parsed tar header block, with its payload bounds resolved. */
interface TarHeader {
  rawName: string;
  prefix: string;
  size: number;
  type: number;
  dataStart: number;
}

/** Read one 512-byte header block; null ends the archive (end marker or malformed). */
function readTarHeader(data: Uint8Array, offset: number): TarHeader | null {
  if (offset + TAR_BLOCK_BYTES > data.length) return null;
  const header = data.subarray(offset, offset + TAR_BLOCK_BYTES);
  if (isZeroBlock(header)) return null;
  const rawName = headerText(header, 0, 100);
  if (!rawName) return null;
  const size = parseOctal(headerText(header, 124, 12));
  if (!Number.isFinite(size) || size < 0) return null;
  const dataStart = offset + TAR_BLOCK_BYTES;
  if (dataStart + size > data.length) return null;
  return { rawName, prefix: headerText(header, 345, 155) || "", size, type: header[156], dataStart };
}

/** Offset of the block after this entry's payload (payloads are block-padded). */
function nextTarOffset(header: TarHeader): number {
  return header.dataStart + Math.ceil(header.size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
}

/** Only these types name the entry that follows (GNU long name / pax extended header). */
function isTarMetadataEntry(type: number): boolean {
  return type === 0x4c || type === 0x78 || type === 0x67;
}

/** True for regular-file entries (plain and GNU/ustar "old" regular). */
function isTarRegularFile(type: number): boolean {
  return type === 0x00 || type === 0x30;
}

/** Path carried by a metadata entry: long name, pax path, or the pending name unchanged. */
function tarMetadataName(data: Uint8Array, header: TarHeader, pendingName: string | null): string | null {
  if (header.type === 0x4c) return headerText(data, header.dataStart, header.size) || null;
  const paxPath = paxRecordPath(data, header.dataStart, header.size);
  return paxPath || pendingName;
}

/** The entry path: an explicit metadata name wins; otherwise prefix + name (ustar). */
function tarEntryName(header: TarHeader, pendingName: string | null): string {
  if (pendingName !== null) return pendingName;
  return header.prefix ? `${header.prefix}/${header.rawName}` : header.rawName;
}

/**
 * Record a regular file entry. Returns the new running total, or null when the
 * cumulative cap would be exceeded (the caller stops parsing).
 */
function addTarEntry(
  files: FileTree,
  data: Uint8Array,
  header: TarHeader,
  name: string,
  total: number,
): number | null {
  const path = safeArchivePath(name);
  if (!path || header.size <= 0 || files.has(path)) return total;
  const nextTotal = total + header.size;
  if (nextTotal > ARCHIVE_LIMITS.totalBytes) return null;
  files.set(path, data.subarray(header.dataStart, header.dataStart + header.size));
  return nextTotal;
}

/** Cursor state carried between tar entry parses. */
interface TarStep {
  offset: number;
  pendingName: string | null;
  total: number;
}

/**
 * Parse one entry. Returns the next cursor state, or null when the archive is
 * done (end marker, malformed header, or the cumulative size cap was hit).
 */
function parseTarEntry(
  data: Uint8Array,
  offset: number,
  pendingName: string | null,
  files: FileTree,
  total: number,
): TarStep | null {
  const header = readTarHeader(data, offset);
  if (!header) return null;
  const nextOffset = nextTarOffset(header);
  // Oversized single entries are skipped, not fatal: codeload tarballs list
  // entries alphabetically, so a large asset (e.g. assets/huge.bin) can
  // precede plugin.json and must not abort the whole parse. Bomb protection
  // is still enforced via the cumulative total below.
  if (header.size > ARCHIVE_LIMITS.singleFileBytes) return { offset: nextOffset, pendingName, total };
  if (isTarMetadataEntry(header.type)) {
    return { offset: nextOffset, pendingName: tarMetadataName(data, header, pendingName), total };
  }
  const name = tarEntryName(header, pendingName);
  if (!isTarRegularFile(header.type)) return { offset: nextOffset, pendingName: null, total };
  const nextTotal = addTarEntry(files, data, header, name, total);
  return nextTotal === null ? null : { offset: nextOffset, pendingName: null, total: nextTotal };
}

function parseTar(data: Uint8Array): FileTree {
  const files: FileTree = new Map();
  let offset = 0;
  let pendingName: string | null = null;
  let total = 0;
  while (files.size <= ARCHIVE_LIMITS.maxEntries) {
    const step = parseTarEntry(data, offset, pendingName, files, total);
    if (!step) break;
    ({ offset, pendingName, total } = step);
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