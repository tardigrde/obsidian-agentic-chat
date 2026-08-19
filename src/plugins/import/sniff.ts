import type { FileTree } from "./archive";

/** The package format a source directory is written in. */
export type ManifestFormat = "agent-plugins" | "claude" | "codex" | "vscode" | "none";

export interface SniffedCandidate {
  /** Directory within the source tree the package lives in ("" = tree root). */
  root: string;
  /** Display name: manifest name when readable, else the folder name. */
  name: string;
  format: ManifestFormat;
  /** Tree path of the package manifest, when one exists. */
  manifestPath?: string;
  /** True when a 1.0.0 `$schema` was seen (Agent Plugins native). */
  isAgentPlugins: boolean;
}

export interface MarketplaceSourceEntry {
  /** `./path` source entries only; absolute/git/npm/archive sources are listed, not resolved. */
  kind: "local" | "remote";
  /** Display name of the plugin. */
  name: string;
  /** Local folder when `./`-relative, prefixed with the marketplace root. */
  folder?: string;
  /** Original source value (git/npm/url) when not locally resolvable. */
  source?: string;
}

/** Result of sniffing a source tree: packages to offer for import. */
export type SniffResult =
  | { kind: "package"; candidates: SniffedCandidate[] }
  | { kind: "marketplace"; name: string; sources: MarketplaceSourceEntry[] }
  | { kind: "nothing"; error: string };

const AP_SCHEMA_MARKERS = ["https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", "https://api.agent-plugins.org/schemas/1.0.0/plugin.schema.json"];

const DECODER = new TextDecoder("utf-8");

/**
 * Identify installable packages inside a source tree. Order follows the
 * documented client lookup order: root `plugin.json` (Agent Plugins or
 * Copilot), `.claude-plugin/`, `.codex-plugin/`, `.plugin/`, a root
 * `marketplace.json` catalog, a depth≤2 scan, then a bare root-level SKILL.md.
 */
export function sniffSource(tree: FileTree): SniffResult {
  const rootManifest = manifestAtRoot(tree);
  if (rootManifest) {
    return { kind: "package", candidates: [candidate(tree, "", rootManifest.format, rootManifest.isAgentPlugins)] };
  }

  for (const [dotDir, format] of [
    [".claude-plugin", "claude"],
    [".codex-plugin", "codex"],
    [".plugin", "vscode"],
  ] as const) {
    if (tree.has(`${dotDir}/plugin.json`)) {
      return {
        kind: "package",
        candidates: [candidate(tree, dotDir, format, false)],
      };
    }
  }

  const marketplace = findMarketplace(tree);
  if (marketplace) return marketplace;

  const deep = findDeepPackages(tree);
  if (deep.length > 0) {
    return { kind: "package", candidates: deep };
  }

  if (tree.has("SKILL.md")) {
    return {
      kind: "package",
      candidates: [
        { root: "", name: skillNameFromDoc(tree.get("SKILL.md") as Uint8Array), format: "none", isAgentPlugins: false },
      ],
    };
  }

  const sample = [...tree.keys()].slice(0, 4).join(", ");
  return {
    kind: "nothing",
    error:
      "No agent plugin package found in this source. An Agent Plugins package has a " +
      "plugin.json with a 1.0.0 schema at its root, or a skills/<name>/SKILL.md directory. " +
      `Files seen: ${sample || "(empty)"}.`,
  };
}

type ManifestFind = { format: ManifestFormat; isAgentPlugins: boolean } | null;

/** A root-level plugin.json (Agent Plugins schema or a Copilot/VS Code-style one). */
function manifestAtRoot(tree: FileTree): ManifestFind {
  const bytes = tree.get("plugin.json");
  if (!bytes) return null;
  const isAgentPlugins = isAgentPluginsSchema(DECODER.decode(bytes));
  return { format: isAgentPlugins ? "agent-plugins" : "vscode", isAgentPlugins };
}

function isAgentPluginsSchema(raw: string): boolean {
  return AP_SCHEMA_MARKERS.some((marker) => raw.includes(marker));
}

function candidate(tree: FileTree, root: string, format: ManifestFormat, isAgentPlugins: boolean): SniffedCandidate {
  return {
    root,
    format,
    isAgentPlugins,
    name: candidateName(tree, root),
    manifestPath: root ? `${root}/plugin.json` : "plugin.json",
  };
}

function candidateName(tree: FileTree, root: string): string {
  const prefix = root ? `${root}/` : "";
  const manifest = tree.get(`${prefix}plugin.json`);
  if (manifest) {
    const parsed = parseJson(manifest);
    if (parsed && typeof parsed.name === "string" && parsed.name.trim()) return parsed.name.trim();
  }
  return root ? root.split("/").pop() ?? root : "(root)";
}

function parseJson(bytes: Uint8Array | undefined): Record<string, unknown> | null {
  if (!bytes) return null;
  try {
    const parsed: unknown = JSON.parse(DECODER.decode(bytes));
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Depth≤2 subdirectory scan for packages placed under a folder (repo layouts
 * like `plugins/<name>/plugin.json` or `skills/<name>/SKILL.md`).
 */
function findDeepPackages(tree: FileTree): SniffedCandidate[] {
  const dirs = new Set<string>();
  for (const path of tree.keys()) {
    const parts = path.split("/");
    for (let depth = 1; depth <= 2; depth += 1) {
      if (parts.length > depth) dirs.add(parts.slice(0, depth).join("/"));
    }
  }
  const packages: SniffedCandidate[] = [];
  for (const dir of [...dirs].sort()) {
    const found = manifestAtRoot(subtreeAt(tree, dir));
    if (found) {
      packages.push(candidate(tree, dir, found.format, found.isAgentPlugins));
    } else if (tree.has(`${dir}/SKILL.md`)) {
      packages.push({
        root: dir,
        format: "none",
        isAgentPlugins: false,
        name: dir.split("/").pop() ?? dir,
      });
    }
  }
  return packages;
}

/** Re-root the tree at `dir` (paths inside keep their relative form). */
function subtreeAt(tree: FileTree, dir: string): FileTree {
  const prefix = `${dir}/`;
  const subtree: FileTree = new Map();
  for (const [path, bytes] of tree) {
    if (path.startsWith(prefix)) subtree.set(path.slice(prefix.length), bytes);
  }
  return subtree;
}

function findMarketplace(tree: FileTree): { kind: "marketplace"; name: string; sources: MarketplaceSourceEntry[] } | null {
  for (const path of ["marketplace.json", ".claude-plugin/marketplace.json", ".agents/plugins/marketplace.json"]) {
    const bytes = tree.get(path);
    if (!bytes) continue;
    const parsed = parseJson(bytes);
    if (!parsed) continue;
    const sources = marketplaceSources(parsed);
    const name = typeof parsed.name === "string" ? parsed.name : path;
    return { kind: "marketplace", name, sources };
  }
  return null;
}

/** Read catalog sources, resolving only `./`-relative folders present in the tree. */
function marketplaceSources(parsed: Record<string, unknown>): MarketplaceSourceEntry[] {
  const list = Array.isArray(parsed.sources) ? parsed.sources : [];
  const entries: MarketplaceSourceEntry[] = [];
  for (const raw of list) {
    if (raw === null || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const source = typeof entry.source === "string" ? entry.source : "";
    const name = typeof entry.name === "string" ? entry.name : source.split("/").pop() || source || "(unnamed)";
    if (source.startsWith("./")) entries.push({ kind: "local", name, folder: source.slice(2) });
    else entries.push({ kind: "remote", name, source });
  }
  return entries;
}

/** Best-effort name of a bare skill document, from its `name:` frontmatter. */
function skillNameFromDoc(bytes: Uint8Array): string {
  const text = DECODER.decode(bytes).slice(0, 2000);
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return "skill";
  const name = /^name:\s*(.+)$/m.exec(match[1]);
  return (name?.[1] ?? "skill").trim().replace(/['"]/g, "");
}