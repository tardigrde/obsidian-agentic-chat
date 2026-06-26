import type { App, DataAdapter, Plugin } from "obsidian";
import { normalizeFolderPath } from "../vault/path";

export interface ToolArtifactMetadata {
  id: string;
  label: string;
  sourceToolName: string;
  contentType: string;
  createdAt: string;
  charLength: number;
}

export interface ToolArtifactWriteInput {
  label: string;
  sourceToolName: string;
  text: string;
  contentType?: string;
}

export interface ToolArtifactReadResult {
  metadata: ToolArtifactMetadata;
  text: string;
}

export interface ToolArtifactStoreLike {
  writeArtifact(input: ToolArtifactWriteInput): Promise<ToolArtifactMetadata>;
  readArtifact(id: string): Promise<ToolArtifactReadResult>;
}

export interface ToolArtifactStoreOptions {
  maxArtifactAgeMs?: number;
  maxArtifactCount?: number;
  now?: () => number;
}

const DEFAULT_MAX_ARTIFACT_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ARTIFACT_COUNT = 200;

export class ToolArtifactStore implements ToolArtifactStoreLike {
  private readonly adapter: DataAdapter;
  private readonly artifactDir: string;
  private readonly maxArtifactAgeMs: number;
  private readonly maxArtifactCount: number;
  private readonly now: () => number;

  constructor(adapter: DataAdapter, artifactDir: string, options: ToolArtifactStoreOptions = {}) {
    this.adapter = adapter;
    this.artifactDir = normalizeFolderPath(artifactDir, { allowPluginInternals: true });
    this.maxArtifactAgeMs = options.maxArtifactAgeMs ?? DEFAULT_MAX_ARTIFACT_AGE_MS;
    this.maxArtifactCount = options.maxArtifactCount ?? DEFAULT_MAX_ARTIFACT_COUNT;
    this.now = options.now ?? Date.now;
  }

  static forPlugin(app: App, plugin: Plugin): ToolArtifactStore {
    const pluginDir = plugin.manifest.dir ?? `${app.vault.configDir}/plugins/${plugin.manifest.id}`;
    return new ToolArtifactStore(app.vault.adapter, `${pluginDir}/artifacts`);
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
    return { metadata: parseMetadata(metadataText, safeId, text.length), text };
  }

  async cleanupArtifacts(): Promise<void> {
    if (!(await this.adapter.exists(this.artifactDir))) return;
    const listing = await this.adapter.list(this.artifactDir);
    const metadataFiles = listing.files.filter((path) => path.endsWith(".json"));
    const artifacts = await Promise.all(metadataFiles.map((path) => this.readMetadataFile(path)));
    const validArtifacts = artifacts.filter((artifact): artifact is ToolArtifactMetadata => artifact !== null);
    const now = this.now();
    const byNewest = [...validArtifacts].sort((left, right) => timestampOf(right.createdAt) - timestampOf(left.createdAt));
    const keep = new Set<string>();
    for (const artifact of byNewest) {
      const ageMs = now - timestampOf(artifact.createdAt);
      if (ageMs <= this.maxArtifactAgeMs && keep.size < this.maxArtifactCount) keep.add(artifact.id);
    }
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
      return parseMetadata(text, id, 0);
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

function parseMetadata(text: string, id: string, fallbackLength: number): ToolArtifactMetadata {
  const parsed = JSON.parse(text) as Partial<ToolArtifactMetadata>;
  return {
    id: typeof parsed.id === "string" ? parsed.id : id,
    label: typeof parsed.label === "string" ? parsed.label : id,
    sourceToolName: typeof parsed.sourceToolName === "string" ? parsed.sourceToolName : "unknown",
    contentType: typeof parsed.contentType === "string" ? parsed.contentType : "text/plain",
    createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
    charLength: typeof parsed.charLength === "number" ? parsed.charLength : fallbackLength,
  };
}

function timestampOf(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}
