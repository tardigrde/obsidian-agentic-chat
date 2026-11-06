import { describe, expect, it } from "vitest";
import {
  bootstrapSemanticIndex,
  readSemanticIndexFile,
  type SemanticIndexBootstrapResult,
} from "../src/retrieval/semantic-index";
import { MemoryAdapter } from "./helpers/memory-adapter";
import {
  DeterministicFakeEmbedder,
  MULTILINGUAL_RETRIEVAL_FIXTURE,
} from "./helpers/retrieval-fixtures";

const scope = { kind: "folder" as const, label: "Projects", paths: ["Projects"] };
const path = "semantic/atomic/index.json";
const backupPath = `${path}.bak`;

async function seed(
  adapter: MemoryAdapter,
  documentCount: number,
  updatedAt: number,
): Promise<SemanticIndexBootstrapResult> {
  return bootstrapSemanticIndex({
    adapter: adapter.asDataAdapter(),
    path,
    scope,
    documents: MULTILINGUAL_RETRIEVAL_FIXTURE.slice(0, documentCount),
    embedder: new DeterministicFakeEmbedder(),
    batchSize: 1,
    now: () => updatedAt,
  });
}

function parse(adapter: MemoryAdapter, file: string) {
  const content = adapter.files.get(file);
  if (!content) throw new Error(`missing ${file}`);
  return JSON.parse(content) as {
    updatedAt: number;
    state: { status: { state: string }; indexedDocumentIds: string[] };
  };
}

describe("semantic index atomic writes", () => {
  it("backs up the previous complete index before replacing it", async () => {
    const adapter = new MemoryAdapter();
    const first = await seed(adapter, 2, 1_000);
    const second = await seed(adapter, 1, 2_000);

    expect(second.completed).toBe(true);
    expect(parse(adapter, path).state.status.state).toBe("complete");
    expect(adapter.files.has(backupPath)).toBe(true);
    expect(parse(adapter, backupPath).state.status.state).toBe("complete");
    expect(parse(adapter, backupPath).state.indexedDocumentIds).toEqual(
      first.file.state.indexedDocumentIds,
    );
    expect(parse(adapter, path).state.indexedDocumentIds).toEqual(
      second.file.state.indexedDocumentIds,
    );
  });

  it("keeps the last complete index when the target replace fails", async () => {
    const adapter = new MemoryAdapter();
    await seed(adapter, 2, 1_000);
    const old = adapter.files.get(path);
    const originalRename = adapter.rename.bind(adapter);
    let targetAttempts = 0;
    adapter.rename = async (from, to) => {
      if (to === path) {
        targetAttempts += 1;
        throw new Error("rename failed");
      }
      return originalRename(from, to);
    };

    await expect(seed(adapter, 1, 2_000)).rejects.toThrow("rename failed");
    expect(targetAttempts).toBe(2);
    expect(adapter.files.has(path)).toBe(false);

    const stored = await readSemanticIndexFile(adapter.asDataAdapter(), path);
    expect(stored?.state.status.state).toBe("complete");
    expect(stored?.updatedAt).toBe(JSON.parse(old ?? "{}").updatedAt);
  });

  it("leaves the target untouched when the backup write fails", async () => {
    const adapter = new MemoryAdapter();
    await seed(adapter, 2, 1_000);
    const old = adapter.files.get(path);
    const originalWrite = adapter.write.bind(adapter);
    adapter.write = async (target, data) => {
      if (target === `${backupPath}.tmp`) throw new Error("backup write failed");
      return originalWrite(target, data);
    };

    await expect(seed(adapter, 1, 2_000)).rejects.toThrow("backup write failed");
    expect(adapter.files.get(path)).toBe(old);
  });

  it("keeps the backup while a rebuild is interrupted", async () => {
    const adapter = new MemoryAdapter();
    await seed(adapter, 2, 1_000);
    await seed(adapter, 1, 2_000);
    const completeBefore = adapter.files.get(path);

    const embedder = new DeterministicFakeEmbedder();
    const originalEmbed = embedder.embedBatch.bind(embedder);
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    embedder.embedBatch = async (inputs, options) => {
      started();
      await gate;
      return originalEmbed(inputs, options);
    };
    const controller = new AbortController();
    const run = bootstrapSemanticIndex({
      adapter: adapter.asDataAdapter(),
      path,
      scope,
      documents: MULTILINGUAL_RETRIEVAL_FIXTURE.slice(0, 1),
      embedder,
      batchSize: 1,
      signal: controller.signal,
      now: () => 3_000,
    });

    await startedPromise;
    expect(parse(adapter, path).state.status.state).toBe("running");
    expect(parse(adapter, backupPath).state.status.state).toBe("complete");

    controller.abort();
    release();
    const result = await run;
    expect(result.cancelled).toBe(true);
    expect(adapter.files.get(backupPath)).toBe(completeBefore);
    const stored = await readSemanticIndexFile(adapter.asDataAdapter(), path);
    expect(stored?.state.status.state).toBe("cancelled");
  });

  it("refuses to replace an unreadable target without a complete backup", async () => {
    const adapter = new MemoryAdapter();
    await seed(adapter, 2, 1_000);
    const old = adapter.files.get(path);
    const originalRead = adapter.read.bind(adapter);
    let failRead = true;
    adapter.read = async (file) => {
      if (file === path && failRead) {
        failRead = false;
        throw new Error("transient read");
      }
      return originalRead(file);
    };
    const originalRename = adapter.rename.bind(adapter);
    adapter.rename = async (from, to) => {
      if (to === path) throw new Error("rename failed");
      return originalRename(from, to);
    };

    await expect(seed(adapter, 1, 2_000)).rejects.toThrow(/unreadable/i);
    expect(adapter.files.get(path)).toBe(old);
    expect(adapter.files.has(backupPath)).toBe(false);
  });

  it("replaces an unreadable target when a complete backup exists", async () => {
    const adapter = new MemoryAdapter();
    await seed(adapter, 2, 1_000);
    await seed(adapter, 1, 2_000);
    const originalRead = adapter.read.bind(adapter);
    let failRead = true;
    adapter.read = async (file) => {
      if (file === path && failRead) {
        failRead = false;
        throw new Error("transient read");
      }
      return originalRead(file);
    };

    const result = await seed(adapter, 1, 3_000);
    expect(result.completed).toBe(true);
    expect(parse(adapter, path).updatedAt).toBe(3_000);
  });

  it("falls back to the backup when the target is corrupt or missing", async () => {
    const adapter = new MemoryAdapter();
    await seed(adapter, 2, 1_000);
    await seed(adapter, 1, 2_000);
    const backup = parse(adapter, backupPath);

    await adapter.write(path, "{ not valid json");
    const corrupt = await readSemanticIndexFile(adapter.asDataAdapter(), path);
    expect(corrupt?.updatedAt).toBe(backup.updatedAt);
    expect(corrupt?.state.status.state).toBe("complete");

    await adapter.remove(path);
    const missing = await readSemanticIndexFile(adapter.asDataAdapter(), path);
    expect(missing?.updatedAt).toBe(backup.updatedAt);
    expect(missing?.state.status.state).toBe("complete");
  });
});
