import { Platform, type App, type DataAdapter, type Plugin } from "obsidian";
import { normalizeFolderPath } from "../vault/path";

export interface ToolArtifactMetadata {
  id: string;
  label: string;
  sourceToolName: string;
  contentType: string;
  createdAt: string;
  charLength: number;
  byteLength?: number;
  dedupKey?: string;
  sourceUrl?: string;
  sourceKind?: string;
  sourceTextHash?: string;
  pinned?: boolean;
}

export interface ToolArtifactWriteInput {
  label: string;
  sourceToolName: string;
  text: string;
  contentType?: string;
  dedupKey?: string;
  sourceUrl?: string;
  sourceKind?: string;
  sourceTextHash?: string;
  pinned?: boolean;
}

export interface ToolArtifactReadResult {
  metadata: ToolArtifactMetadata;
  text: string;
}

export interface ToolArtifactStoreLike {
  writeArtifact(input: ToolArtifactWriteInput): Promise<ToolArtifactMetadata>;
  readArtifact(id: string): Promise<ToolArtifactReadResult>;
  listArtifacts?(): Promise<ToolArtifactMetadata[]>;
  deleteArtifact?(id: string): Promise<boolean>;
  clearArtifacts?(): Promise<number>;
  cleanupArtifacts?(): Promise<void>;
  pinArtifact?(id: string, pinned?: boolean): Promise<ToolArtifactMetadata>;
  findArtifactByDedupKey?(dedupKey: string): Promise<ToolArtifactReadResult | null>;
  findArtifactBySourceTextHash?(sourceTextHash: string): Promise<ToolArtifactReadResult | null>;
}

export interface ToolArtifactStoreOptions {
  maxArtifactAgeMs?: number;
  maxArtifactCount?: number;
  maxTotalArtifactBytes?: number;
  referencedArtifactIds?: () => Iterable<string> | Promise<Iterable<string>>;
  now?: () => number;
}

const DEFAULT_MAX_ARTIFACT_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ARTIFACT_COUNT = 200;
export const DEFAULT_DESKTOP_MAX_TOTAL_ARTIFACT_BYTES = 250 * 1024 * 1024;
export const DEFAULT_MOBILE_MAX_TOTAL_ARTIFACT_BYTES = 100 * 1024 * 1024;

export class ToolArtifactStore implements ToolArtifactStoreLike {
  private readonly adapter: DataAdapter;
  private readonly artifactDir: string;
  private readonly maxArtifactAgeMs: number;
  private readonly maxArtifactCount: number;
  private readonly maxTotalArtifactBytes: number;
  private readonly referencedArtifactIds?: () => Iterable<string> | Promise<Iterable<string>>;
  private readonly now: () => number;

  constructor(adapter: DataAdapter, artifactDir: string, options: ToolArtifactStoreOptions = {}) {
    this.adapter = adapter;
    this.artifactDir = normalizeFolderPath(artifactDir, { allowPluginInternals: true });
    this.maxArtifactAgeMs = options.maxArtifactAgeMs ?? DEFAULT_MAX_ARTIFACT_AGE_MS;
    this.maxArtifactCount = options.maxArtifactCount ?? DEFAULT_MAX_ARTIFACT_COUNT;
    this.maxTotalArtifactBytes = normalizeByteLimit(options.maxTotalArtifactBytes ?? defaultMaxTotalArtifactBytes());
    this.referencedArtifactIds = options.referencedArtifactIds;
    this.now = options.now ?? Date.now;
  }

  static forPlugin(app: App, plugin: Plugin, options: ToolArtifactStoreOptions = {}): ToolArtifactStore {
    const pluginDir = plugin.manifest.dir ?? `${app.vault.configDir}/plugins/${plugin.manifest.id}`;
    return new ToolArtifactStore(app.vault.adapter, `${pluginDir}/artifacts`, options);
  }

  async writeArtifact(input: ToolArtifactWriteInput): Promise<ToolArtifactMetadata> {
    await ensureFolder(this.adapter, this.artifactDir);
    const metadata: ToolArtifactMetadata = {
      id: createArtifactId(),
      label: input.label,
      sourceToolName: input.sourceToolName,
      contentType: input.contentType ?? "text/plain",
      createdAt: new Date(this.now()).toISOString(),
      charLength: input.text.length,
      byteLength: utf8ByteLength(input.text),
      dedupKey: input.dedupKey,
      sourceUrl: input.sourceUrl,
      sourceKind: input.sourceKind,
      sourceTextHash: input.sourceTextHash,
      pinned: input.pinned === true,
    };
    await this.adapter.write(this.artifactPath(metadata.id), input.text);
    await this.adapter.write(this.metadataPath(metadata.id), JSON.stringify(metadata, null, 2));
    await this.cleanupArtifacts();
    return metadata;
  }

  async readArtifact(id: string): Promise<ToolArtifactReadResult> {
    const safeId = normalizeArtifactId(id);
    const [metadataText, text] = await Promise.all([
      this.adapter.read(this.metadataPath(safeId)),
      this.adapter.read(this.artifactPath(safeId)),
    ]);
    return { metadata: parseMetadata(metadataText, safeId, text.length, utf8ByteLength(text)), text };
  }

  async findArtifactByDedupKey(dedupKey: string): Promise<ToolArtifactReadResult | null> {
    const key = dedupKey.trim();
    const match = key ? await this.findNewestArtifact((artifact) => artifact.dedupKey === key) : null;
    return match ? this.readArtifact(match.id) : null;
  }

  async findArtifactBySourceTextHash(sourceTextHash: string): Promise<ToolArtifactReadResult | null> {
    const hash = sourceTextHash.trim();
    const match = hash ? await this.findNewestArtifact((artifact) => artifact.sourceTextHash === hash) : null;
    return match ? this.readArtifact(match.id) : null;
  }

  async listArtifacts(): Promise<ToolArtifactMetadata[]> {
    return this.readAllMetadata();
  }

  async deleteArtifact(id: string): Promise<boolean> {
    const safeId = normalizeArtifactId(id);
    const existed = (await this.adapter.exists(this.artifactPath(safeId))) || (await this.adapter.exists(this.metadataPath(safeId)));
    if (existed) await this.removeArtifactFiles(safeId);
    return existed;
  }

  async clearArtifacts(): Promise<number> {
    const artifacts = await this.readAllMetadata();
    const ids = new Set(artifacts.map((artifact) => artifact.id));
    for (const id of ids) await this.removeArtifactFiles(id);
    if (await this.adapter.exists(this.artifactDir)) {
      const listing = await this.adapter.list(this.artifactDir);
      await this.removeOrphanArtifactFiles(listing.files, new Set());
    }
    return ids.size;
  }

  async pinArtifact(id: string, pinned = true): Promise<ToolArtifactMetadata> {
    const safeId = normalizeArtifactId(id);
    const stat = await this.adapter.stat(this.artifactPath(safeId));
    const metadata = parseMetadata(await this.adapter.read(this.metadataPath(safeId)), safeId, 0, stat?.size ?? 0);
    const next = { ...metadata, pinned };
    await this.adapter.write(this.metadataPath(safeId), JSON.stringify(next, null, 2));
    return next;
  }

  async cleanupArtifacts(): Promise<void> {
    if (!(await this.adapter.exists(this.artifactDir))) return;
    const listing = await this.adapter.list(this.artifactDir);
    const metadataFiles = listing.files.filter((path) => path.endsWith(".json"));
    const artifacts = await Promise.all(metadataFiles.map((path) => this.readMetadataFile(path)));
    const validArtifacts = artifacts.filter((artifact): artifact is ToolArtifactMetadata => artifact !== null);
    const now = this.now();
    const referenced = await this.currentReferencedArtifactIds();
    const byNewest = [...validArtifacts].sort((left, right) => timestampOf(right.createdAt) - timestampOf(left.createdAt));
    const keep = new Set<string>();
    for (const artifact of byNewest) {
      if (artifact.pinned || referenced.has(artifact.id)) keep.add(artifact.id);
    }
    let keptUnpinned = 0;
    for (const artifact of byNewest) {
      if (artifact.pinned || referenced.has(artifact.id)) continue;
      const ageMs = now - timestampOf(artifact.createdAt);
      if (ageMs <= this.maxArtifactAgeMs && keptUnpinned < this.maxArtifactCount) {
        keep.add(artifact.id);
        keptUnpinned += 1;
      }
    }
    enforceTotalByteLimit(keep, byNewest, this.maxTotalArtifactBytes, referenced);
    const knownIds = new Set(validArtifacts.map((artifact) => artifact.id));
    for (const artifact of validArtifacts) {
      if (!keep.has(artifact.id)) await this.removeArtifactFiles(artifact.id);
    }
    await this.removeOrphanArtifactFiles(listing.files, knownIds);
  }

  private artifactPath(id: string): string {
    return `${this.artifactDir}/${id}.txt`;
  }

  private metadataPath(id: string): string {
    return `${this.artifactDir}/${id}.json`;
  }

  private async readMetadataFile(path: string): Promise<ToolArtifactMetadata | null> {
    try {
      const id = path.split("/").pop()?.replace(/\.json$/, "") ?? "";
      const text = await this.adapter.read(path);
      const stat = await this.adapter.stat(this.artifactPath(id));
      return parseMetadata(text, id, 0, stat?.size ?? 0);
    } catch {
      return null;
    }
  }

  private async removeArtifactFiles(id: string): Promise<void> {
    await Promise.all([this.removeIfExists(this.artifactPath(id)), this.removeIfExists(this.metadataPath(id))]);
  }

  private async removeOrphanArtifactFiles(files: readonly string[], knownIds: Set<string>): Promise<void> {
    for (const path of files) {
      const match = /\/([^/]+)\.(txt|json)$/.exec(path);
      if (match && !knownIds.has(match[1])) await this.removeIfExists(path);
    }
  }

  private async removeIfExists(path: string): Promise<void> {
    if (await this.adapter.exists(path)) await this.adapter.remove(path);
  }

  private async findNewestArtifact(
    predicate: (artifact: ToolArtifactMetadata) => boolean,
  ): Promise<ToolArtifactMetadata | null> {
    const artifacts = await this.readAllMetadata();
    return artifacts
      .filter(predicate)
      .sort((left, right) => timestampOf(right.createdAt) - timestampOf(left.createdAt))[0] ?? null;
  }

  private async currentReferencedArtifactIds(): Promise<Set<string>> {
    if (!this.referencedArtifactIds) return new Set();
    const ids = await this.referencedArtifactIds();
    return new Set([...ids].filter((id) => /^[A-Za-z0-9_-]+$/.test(id)));
  }

  private async readAllMetadata(): Promise<ToolArtifactMetadata[]> {
    if (!(await this.adapter.exists(this.artifactDir))) return [];
    const listing = await this.adapter.list(this.artifactDir);
    const artifacts = await Promise.all(
      listing.files.filter((path) => path.endsWith(".json")).map((path) => this.readMetadataFile(path)),
    );
    return artifacts
      .filter((artifact): artifact is ToolArtifactMetadata => artifact !== null)
      .sort((left, right) => timestampOf(right.createdAt) - timestampOf(left.createdAt));
  }
}

async function ensureFolder(adapter: DataAdapter, path: string): Promise<void> {
  let current = "";
  for (const segment of path.split("/")) {
    current = current ? `${current}/${segment}` : segment;
    if (!(await adapter.exists(current))) {
      await adapter.mkdir(current);
    }
  }
}

function createArtifactId(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `tool-${timestamp}-${random}`;
}

function normalizeArtifactId(id: string): string {
  const trimmed = id.trim();
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) throw new Error("Artifact id must contain only letters, numbers, '_' or '-'.");
  return trimmed;
}

function parseMetadata(
  text: string,
  id: string,
  fallbackCharLength: number,
  fallbackByteLength: number,
): ToolArtifactMetadata {
  const parsed = JSON.parse(text) as Partial<ToolArtifactMetadata>;
  return {
    id: typeof parsed.id === "string" ? parsed.id : id,
    label: typeof parsed.label === "string" ? parsed.label : id,
    sourceToolName: typeof parsed.sourceToolName === "string" ? parsed.sourceToolName : "unknown",
    contentType: typeof parsed.contentType === "string" ? parsed.contentType : "text/plain",
    createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
    charLength: typeof parsed.charLength === "number" ? parsed.charLength : fallbackCharLength,
    byteLength: nonNegativeNumber(parsed.byteLength) ?? fallbackByteLength,
    dedupKey: typeof parsed.dedupKey === "string" ? parsed.dedupKey : undefined,
    sourceUrl: typeof parsed.sourceUrl === "string" ? parsed.sourceUrl : undefined,
    sourceKind: typeof parsed.sourceKind === "string" ? parsed.sourceKind : undefined,
    sourceTextHash: typeof parsed.sourceTextHash === "string" ? parsed.sourceTextHash : undefined,
    pinned: parsed.pinned === true,
  };
}

function timestampOf(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function enforceTotalByteLimit(
  keep: Set<string>,
  artifactsByNewest: readonly ToolArtifactMetadata[],
  maxTotalArtifactBytes: number,
  referenced: ReadonlySet<string>,
): void {
  let totalBytes = 0;
  for (const artifact of artifactsByNewest) {
    if (keep.has(artifact.id)) totalBytes += artifactStorageBytes(artifact);
  }
  for (const artifact of [...artifactsByNewest].reverse()) {
    if (totalBytes <= maxTotalArtifactBytes) return;
    if (artifact.pinned || referenced.has(artifact.id) || !keep.has(artifact.id)) continue;
    keep.delete(artifact.id);
    totalBytes -= artifactStorageBytes(artifact);
  }
}

function artifactStorageBytes(artifact: ToolArtifactMetadata): number {
  return artifact.byteLength ?? artifact.charLength;
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function defaultMaxTotalArtifactBytes(): number {
  const platform = Platform as { isMobile?: boolean };
  return platform.isMobile ? DEFAULT_MOBILE_MAX_TOTAL_ARTIFACT_BYTES : DEFAULT_DESKTOP_MAX_TOTAL_ARTIFACT_BYTES;
}

function normalizeByteLimit(value: number): number {
  if (!Number.isFinite(value)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.trunc(value));
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
