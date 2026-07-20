export type AttachmentFragment =
  | { type: "heading"; value: string; raw: string }
  | { type: "block"; value: string; raw: string };

export interface VaultAttachmentRef {
  path: string;
  fragment: AttachmentFragment | null;
}

/** Parse Obsidian-style note subrefs: `Note.md#Heading` and `Note.md^block-id`. */
export function parseVaultAttachmentRef(entry: string): VaultAttachmentRef {
  const hash = entry.indexOf("#");
  const caret = entry.indexOf("^");
  let delimiter: number;
  if (hash === -1) delimiter = caret;
  else if (caret === -1) delimiter = hash;
  else delimiter = Math.min(hash, caret);
  if (delimiter <= 0) return { path: entry, fragment: null };

  const path = entry.slice(0, delimiter);
  const raw = entry.slice(delimiter);
  const value = raw.slice(1).trim();
  if (!value) return { path: entry, fragment: null };
  return {
    path,
    fragment: {
      type: raw.startsWith("#") ? "heading" : "block",
      value: decodeAttachmentFragment(value),
      raw,
    },
  };
}

export function attachmentBasePath(entry: string): string {
  return parseVaultAttachmentRef(entry).path;
}

export function attachmentDisplayPath(ref: VaultAttachmentRef): string {
  return `${ref.path}${ref.fragment?.raw ?? ""}`;
}

function decodeAttachmentFragment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
