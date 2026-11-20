/**
 * Binary-file detection for the `read` tool. A vault read decodes bytes as
 * UTF-8, so a PNG or PDF came back as replacement characters the model could
 * mistake for content. Known binary extensions are refused before the read;
 * any other file is refused when its text holds NUL bytes or many U+FFFD.
 */

const BINARY_KINDS: Record<string, string> = {
  png: "PNG image",
  jpg: "JPEG image",
  jpeg: "JPEG image",
  gif: "GIF image",
  webp: "WebP image",
  bmp: "BMP image",
  ico: "icon image",
  tif: "TIFF image",
  tiff: "TIFF image",
  heic: "HEIC image",
  avif: "AVIF image",
  pdf: "PDF document",
  epub: "EPUB book",
  docx: "Word document",
  xlsx: "Excel workbook",
  pptx: "PowerPoint deck",
  doc: "Word document",
  xls: "Excel workbook",
  ppt: "PowerPoint deck",
  zip: "ZIP archive",
  gz: "gzip archive",
  "7z": "7z archive",
  rar: "RAR archive",
  mp3: "audio file",
  m4a: "audio file",
  wav: "audio file",
  ogg: "audio file",
  flac: "audio file",
  webm: "video file",
  mp4: "video file",
  mov: "video file",
  mkv: "video file",
  woff: "font file",
  woff2: "font file",
  ttf: "font file",
  otf: "font file",
  exe: "program file",
  dll: "program file",
  so: "program file",
  wasm: "WebAssembly module",
  sqlite: "database file",
  db: "database file",
};

const DOCUMENT_EXTENSIONS = new Set(["pdf", "epub", "docx", "pptx", "xlsx"]);
const IMAGE_KIND = / image$/;

function extensionOf(path: string): string {
  const base = path.split("/").pop() ?? "";
  return base.includes(".") ? (base.split(".").pop() ?? "").toLowerCase() : "";
}

/** The kind of a known binary file, by extension, or null. */
export function binaryKindByExtension(path: string): string | null {
  const ext = extensionOf(path);
  return Object.prototype.hasOwnProperty.call(BINARY_KINDS, ext) ? BINARY_KINDS[ext] : null;
}

/**
 * True when decoded text looks like binary data: a NUL byte, or over 30%
 * U+FFFD in the first 4 KB. A legacy-encoded note (cp1250 Hungarian decoded as
 * UTF-8) shows U+FFFD only for its accented letters, far below 30%.
 */
export function looksBinary(text: string): boolean {
  const sample = text.slice(0, 4096);
  if (sample.includes("\u0000")) return true;
  if (sample.length === 0) return false;
  let replacements = 0;
  for (const char of sample) if (char === "�") replacements += 1;
  return replacements / sample.length > 0.3;
}

/** The `read` error for a binary file, with the next step for that kind. */
export function binaryReadError(path: string, kind: string | null, sizeBytes: number | undefined): Error {
  const size = sizeBytes !== undefined && sizeBytes > 0 ? `, ${formatBytes(sizeBytes)}` : "";
  const label = kind ?? "binary data";
  const ext = extensionOf(path);
  const next = DOCUMENT_EXTENSIONS.has(ext)
    ? `Use import_document to extract its text.`
    : kind && IMAGE_KIND.test(kind)
      ? `To look at an image, ask the user to attach it to the chat (it reaches the model as an image when the model accepts images).`
      : `Do not guess its content.`;
  return new Error(`${path} is a binary file (${label}${size}). read returns text only. ${next}`);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
