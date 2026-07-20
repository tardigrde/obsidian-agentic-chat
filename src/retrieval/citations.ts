export type SourceReference =
  | NoteSourceReference
  | UrlSourceReference
  | ArtifactSourceReference;

export type NoteSourceFragment =
  | { type: "heading"; value: string }
  | { type: "block"; value: string };

export interface NoteSourceReference {
  type: "note";
  path?: string;
  fragment?: NoteSourceFragment;
  label?: string;
}

export interface UrlSourceReference {
  type: "url";
  url: string;
  label?: string;
}

export interface ArtifactSourceReference {
  type: "artifact";
  artifactId: string;
  label?: string;
}

const ARTIFACT_TARGET = /^artifact:([A-Za-z0-9_-]+)$/;

export function parseSourceReference(input: string): SourceReference | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const markdown = parseMarkdownLink(trimmed);
  if (markdown) return withLabel(parseSourceTarget(markdown.target), markdown.label);

  const wiki = parseWikiLink(trimmed);
  if (wiki) return withLabel(parseSourceTarget(wiki.target), wiki.label);

  return parseSourceTarget(trimmed);
}

export function parseSourceReferences(values: readonly string[]): SourceReference[] {
  return values
    .map((value) => parseSourceReference(value))
    .filter((value): value is SourceReference => value !== null);
}

export function sourceReferenceTarget(reference: SourceReference): string {
  switch (reference.type) {
    case "note":
      return noteTarget(reference);
    case "url":
      return reference.url;
    case "artifact":
      return `artifact:${reference.artifactId}`;
  }
}

export function formatSourceReference(reference: SourceReference): string {
  switch (reference.type) {
    case "note": {
      const target = sourceReferenceTarget(reference);
      const label = reference.label ? `|${reference.label.trim()}` : "";
      return `[[${target}${label}]]`;
    }
    case "url":
      return reference.label
        ? `[${escapeMarkdownLabel(reference.label)}](${reference.url})`
        : reference.url;
    case "artifact":
      return reference.label
        ? `[${escapeMarkdownLabel(reference.label)}](artifact:${reference.artifactId})`
        : `artifact:${reference.artifactId}`;
  }
}

export function sourceReferenceKey(reference: SourceReference): string {
  switch (reference.type) {
    case "note":
      return `note:${sourceReferenceTarget(reference).toLowerCase()}`;
    case "url":
      return `url:${reference.url}`;
    case "artifact":
      return `artifact:${reference.artifactId}`;
  }
}

export function normalizeObsidianLinkTarget(target: string): string | null {
  const reference = parseNoteTarget(target);
  return reference ? noteTarget(reference) : null;
}

function parseSourceTarget(target: string): SourceReference | null {
  const trimmed = target.trim();
  if (!trimmed) return null;

  const artifact = ARTIFACT_TARGET.exec(trimmed);
  if (artifact) return { type: "artifact", artifactId: artifact[1] };

  const url = parseHttpUrl(trimmed);
  if (url) return { type: "url", url };

  return parseNoteTarget(trimmed);
}

function parseMarkdownLink(input: string): { label: string; target: string } | null {
  const match = /^\[([^\]]+)]\(([^)]+)\)$/.exec(input);
  if (!match) return null;
  return { label: match[1].trim(), target: match[2].trim() };
}

function parseWikiLink(input: string): { label?: string; target: string } | null {
  const match = /^\[\[(.+)]]$/.exec(input);
  if (!match) return null;
  const inner = match[1].trim();
  const pipe = inner.indexOf("|");
  if (pipe === -1) return { target: inner };
  return {
    target: inner.slice(0, pipe).trim(),
    label: inner.slice(pipe + 1).trim() || undefined,
  };
}

function parseNoteTarget(target: string): NoteSourceReference | null {
  const normalizedTarget = target.trim();
  if (!normalizedTarget) return null;

  if (normalizedTarget.startsWith("^")) {
    const block = normalizeBlockId(normalizedTarget);
    return block ? { type: "note", fragment: { type: "block", value: block } } : null;
  }

  const hash = normalizedTarget.indexOf("#");
  if (hash !== -1) {
    const path = normalizeNotePath(normalizedTarget.slice(0, hash));
    const fragment = normalizeFragment(normalizedTarget.slice(hash + 1));
    if (!path || !fragment) return null;
    return { type: "note", path, fragment };
  }

  const caret = normalizedTarget.indexOf("^");
  if (caret !== -1) {
    const path = normalizeNotePath(normalizedTarget.slice(0, caret));
    const block = normalizeBlockId(normalizedTarget.slice(caret));
    if (!path || !block) return null;
    return { type: "note", path, fragment: { type: "block", value: block } };
  }

  const path = normalizeNotePath(normalizedTarget);
  return path ? { type: "note", path } : null;
}

function normalizeFragment(fragment: string): NoteSourceFragment | null {
  const decoded = decodeFragment(fragment.trim());
  if (!decoded) return null;
  if (decoded.startsWith("^")) {
    const block = normalizeBlockId(decoded);
    return block ? { type: "block", value: block } : null;
  }
  const heading = normalizeHeading(decoded);
  return heading ? { type: "heading", value: heading } : null;
}

function normalizeNotePath(value: string): string | undefined {
  const path = value
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/");
  if (path.includes(":") || path.includes("[") || path.includes("]")) return undefined;
  return path || undefined;
}

function normalizeHeading(value: string): string {
  return decodeFragment(value)
    .replace(/^#+\s*/, "")
    .replace(/\s+#+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeBlockId(value: string): string {
  return decodeFragment(value).trim().replace(/^\^/, "").trim();
}

function decodeFragment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function withLabel(reference: SourceReference | null, label: string | undefined): SourceReference | null {
  if (!reference) return null;
  const normalized = label?.trim();
  return normalized ? { ...reference, label: normalized } : reference;
}

function noteTarget(reference: NoteSourceReference): string {
  const path = reference.path ?? "";
  if (!reference.fragment) return path;
  if (reference.fragment.type === "heading") return `${path}#${reference.fragment.value}`;
  return path ? `${path}#^${reference.fragment.value}` : `^${reference.fragment.value}`;
}

function escapeMarkdownLabel(label: string): string {
  return label
    .replaceAll("\\", String.raw`\\`)
    .replaceAll("[", String.raw`\[`)
    .replaceAll("]", String.raw`\]`);
}
