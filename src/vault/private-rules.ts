// Private content rules: path globs, #tags, and frontmatter properties, comma/newline separated.
// A line starting with "# " is a comment.

import type { IgnoreMatcher } from "./ignore";
import { createFileSystemDenyMatcher, createProtectedPathMatcher } from "./file-system-sandbox";

export interface PropertyRule {
  key: string;
  /** Null: any value. */
  value: string | null;
}

export interface PrivateRules {
  globs: string[];
  /** Lowercase, without the leading `#`. */
  tags: string[];
  properties: PropertyRule[];
}

/** The note facts a tag or property rule reads. */
export interface NoteMetadata {
  /** Tags with or without the leading `#`, inline and frontmatter. */
  tags: readonly string[];
  frontmatter: Record<string, unknown> | null;
}

export type NoteMetadataLookup = (path: string) => NoteMetadata | null;

const PROPERTY_RULE = /^([^\s/*?=#[\]]+)=(.*)$/u;

/** Split the setting into rules. Unknown shapes are path globs. */
export function parsePrivateRules(text: string): PrivateRules {
  const rules: PrivateRules = { globs: [], tags: [], properties: [] };
  for (const raw of text.split(/[\n\r,]+/u)) {
    const rule = raw.normalize("NFC").trim();
    if (!rule || rule === "#" || rule.startsWith("# ") || rule.startsWith("##")) continue;
    if (rule.startsWith("#")) {
      const tag = normalizeTag(rule);
      if (tag) rules.tags.push(tag);
      continue;
    }
    const property = PROPERTY_RULE.exec(rule);
    if (property) {
      const value = property[2].trim();
      rules.properties.push({ key: property[1].toLowerCase(), value: value === "" || value === "*" ? null : value.toLowerCase() });
      // Also keep it as a path glob: a stored literal path such as `todo=done.md`
      // was a glob before property rules existed, and must stay hidden.
      rules.globs.push(rule);
      continue;
    }
    rules.globs.push(rule);
  }
  return rules;
}

function normalizeTag(tag: string): string {
  return tag.replace(/^#+/u, "").trim().toLowerCase();
}

function tagMatches(noteTag: string, rule: string): boolean {
  const tag = normalizeTag(noteTag);
  return tag === rule || tag.startsWith(`${rule}/`);
}

function valueMatches(value: unknown, rule: string | null): boolean {
  if (value === undefined) return false;
  if (rule === null) return true;
  if (Array.isArray(value)) return value.some((entry) => valueMatches(entry, rule));
  if (value === null) return rule === "null";
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return false;
  return String(value).trim().toLowerCase() === rule;
}

/** Whether a note's tags or properties make it private under `rules`. */
export function metadataIsPrivate(metadata: NoteMetadata, rules: Pick<PrivateRules, "tags" | "properties">): boolean {
  if (rules.tags.length > 0 && metadata.tags.some((tag) => rules.tags.some((rule) => tagMatches(tag, rule)))) return true;
  if (rules.properties.length === 0 || !metadata.frontmatter) return false;
  const lowered = new Map(Object.entries(metadata.frontmatter).map(([key, value]) => [key.toLowerCase(), value]));
  return rules.properties.some((rule) => valueMatches(lowered.get(rule.key), rule.value));
}

/**
 * The one private-content matcher: path globs (plus the protected metadata
 * folders) and, through `lookup`, tag and property rules on notes. A path a
 * rule matches is private: the agent cannot read, list, search, or change it.
 */
export function createPrivateMatcher(text: string, configDir?: string, lookup?: NoteMetadataLookup): PrivateMatcher {
  const rules = parsePrivateRules(text);
  const globMatcher = createFileSystemDenyMatcher(rules.globs.join("\n"), configDir);
  const matcher: IgnoreMatcher = !lookup || (rules.tags.length === 0 && rules.properties.length === 0)
    ? (path) => globMatcher(path)
    : (path) => {
        if (globMatcher(path)) return true;
        if (!/\.md$/iu.test(path)) return false;
        const metadata = lookup(path);
        return metadata !== null && metadataIsPrivate(metadata, rules);
      };
  return Object.assign(matcher, { isProtected: createProtectedPathMatcher(configDir) });
}

/**
 * A private matcher that also knows which paths the built-in protected
 * folders block (`.obsidian`, `.git`, `.trash`, the config dir), so the
 * message can name the real cause.
 */
export type PrivateMatcher = IgnoreMatcher & { isProtected?: IgnoreMatcher };

/**
 * What the model reads when it touches a private path. It names the real
 * cause (U5 #10): a built-in protected folder is not a user setting, and a
 * message that blamed "settings" made the model tell the user so.
 */
export function privatePathMessage(path: string, matcher?: PrivateMatcher): string {
  const isProtected = matcher?.isProtected ?? createProtectedPathMatcher();
  if (isProtected(path)) {
    return `Blocked: "${path}" is protected by the plugin (vault metadata such as .obsidian, .git and .trash is never readable; this is built in, not a user setting). Do not try to read or change it another way.`;
  }
  return `Blocked: "${path}" is private (excluded in the Ignored paths setting). Do not try to read or change it another way.`;
}

/** The note facts from Obsidian's metadata cache: inline and frontmatter tags, and frontmatter. */
export function noteMetadataFromCache(cache: {
  tags?: Array<{ tag: string }>;
  frontmatter?: Record<string, unknown>;
} | null | undefined): NoteMetadata | null {
  if (!cache) return null;
  const frontmatter = cache.frontmatter ?? null;
  const tags = (cache.tags ?? []).map((entry) => entry.tag);
  for (const key of ["tags", "tag"]) {
    const value = frontmatter?.[key];
    const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,\s]+/u) : [];
    for (const entry of list) if (typeof entry === "string" && entry.trim()) tags.push(entry.trim());
  }
  return { tags, frontmatter };
}
