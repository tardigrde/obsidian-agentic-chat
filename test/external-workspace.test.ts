import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolArtifactStoreLike, ToolArtifactWriteInput } from "../src/artifacts/tool-artifact-store";
import {
  createExternalWorkspaceTools,
  firstExternalReference,
  openExternalReference,
  type ExternalWorkspaceRuntime,
} from "../src/tools/external-workspace";
import { DEFAULT_SETTINGS, type ExternalWorkspaceSettings } from "../src/settings";

const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function tempDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "agentic-chat-external-"));
  tempRoots.push(root);
  return root;
}

function runtime(opened: string[] = []): ExternalWorkspaceRuntime {
  return {
    fs: fs as unknown as ExternalWorkspaceRuntime["fs"],
    path: path as unknown as ExternalWorkspaceRuntime["path"],
    openPath: async (target) => {
      opened.push(target);
      return "";
    },
  };
}

function settings(rootPath: string, overrides: Partial<ExternalWorkspaceSettings> = {}): ExternalWorkspaceSettings {
  return {
    ...DEFAULT_SETTINGS.external,
    enabled: true,
    rootPath,
    ...overrides,
  };
}

function toolFor(rootPath: string, overrides: Partial<ExternalWorkspaceSettings> = {}): AgentTool {
  const [tool] = createExternalWorkspaceTools(settings(rootPath, overrides), { runtime: runtime() });
  expect(tool).toBeTruthy();
  return tool;
}

function artifactStore(): ToolArtifactStoreLike & { writes: ToolArtifactWriteInput[] } {
  const writes: ToolArtifactWriteInput[] = [];
  return {
    writes,
    async writeArtifact(input) {
      writes.push(input);
      return {
        id: `artifact-${writes.length}`,
        label: input.label,
        sourceToolName: input.sourceToolName,
        contentType: input.contentType ?? "text/plain",
        createdAt: "2026-07-02T00:00:00.000Z",
        charLength: input.text.length,
        dedupKey: input.dedupKey,
        sourceUrl: input.sourceUrl,
        sourceKind: input.sourceKind,
        sourceTextHash: input.sourceTextHash,
        pinned: input.pinned === true,
      };
    },
    async readArtifact() {
      throw new Error("not implemented");
    },
  };
}

async function run(tool: AgentTool, params: unknown): Promise<{ text: string; details: Record<string, unknown> }> {
  const result = await tool.execute("call-1", params as never, undefined);
  return {
    text: result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n"),
    details: (result.details ?? {}) as Record<string, unknown>,
  };
}

describe("external workspace tools", () => {
  it("registers only when enabled with a root path", () => {
    expect(createExternalWorkspaceTools(settings("/tmp/root", { enabled: false }))).toEqual([]);
    expect(createExternalWorkspaceTools(settings("", { enabled: true }))).toEqual([]);
    const tools = createExternalWorkspaceTools(settings("/tmp/root", { enabled: true }));
    expect(tools.map((tool) => tool.name)).toEqual(["external_inspect"]);
    expect(tools[0].description).toContain("reuse prior output");
  });

  it("lists, reads, and searches with external:// citations instead of absolute paths", async () => {
    const root = await tempDir();
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "app.ts"), "const token = true;\nexport const value = token;\n");
    const tool = toolFor(root);

    const listed = await run(tool, { action: "list" });
    expect(listed.text).toContain("external://src/");
    expect(listed.text).not.toContain(root);

    const read = await run(tool, { action: "read", path: "src/app.ts", offset: 2, limit: 1 });
    expect(read.text).toContain("external://src/app.ts lines 2-2 of 3");
    expect(read.text).toContain("export const value = token;");
    expect(read.text).not.toContain(root);

    const explicitRange = await run(tool, { action: "read", path: "src/app.ts", startLine: 1, endLine: 2 });
    expect(explicitRange.text).toContain("external://src/app.ts lines 1-2 of 3");
    expect(explicitRange.details).toMatchObject({ startLine: 1, endLine: 2, totalLines: 3 });

    const searched = await run(tool, { action: "search", query: "token", kind: "content" });
    expect(searched.text).toContain("external://src/app.ts:1: const token = true;");
    expect(searched.text).not.toContain(root);
  });

  it("caches repeated list and read calls when a cache is provided", async () => {
    const root = await tempDir();
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "app.ts"), "export const value = 1;\n");
    const baseRuntime = runtime();
    let readdirCalls = 0;
    let targetReadFileCalls = 0;
    const countingRuntime: ExternalWorkspaceRuntime = {
      ...baseRuntime,
      fs: {
        promises: {
          ...baseRuntime.fs.promises,
          readdir: async (...args) => {
            readdirCalls += 1;
            return baseRuntime.fs.promises.readdir(...args);
          },
          readFile: async (...args) => {
            if (String(args[0]).endsWith(path.join("src", "app.ts"))) targetReadFileCalls += 1;
            return baseRuntime.fs.promises.readFile(...args);
          },
        },
      },
    };
    const cache = new Map();
    const [tool] = createExternalWorkspaceTools(settings(root), { runtime: countingRuntime, cache });
    expect(tool).toBeTruthy();

    const firstList = await run(tool, { action: "list", path: "src" });
    const secondList = await run(tool, { action: "list", path: "src" });
    const thirdList = await run(tool, { action: "list", path: "src" });
    expect(firstList.details.cached).toBeUndefined();
    expect(firstList.text).toContain("cache note");
    expect(secondList.details.cached).toBe(true);
    expect(secondList.details.cacheHitCount).toBe(1);
    expect(secondList.text).toContain("cache hit");
    expect(secondList.text).toContain("do not repeat this exact call again");
    expect(thirdList.details.cached).toBe(true);
    expect(thirdList.details.cacheHitCount).toBe(2);
    expect(thirdList.details.cacheReplaySuppressed).toBe(true);
    expect(thirdList.text).toContain("duplicate guard");
    expect(thirdList.text).not.toContain("app.ts");
    expect(readdirCalls).toBe(1);

    const firstRead = await run(tool, { action: "read", path: "src/app.ts" });
    const secondRead = await run(tool, { action: "read", path: "src/app.ts" });
    const thirdRead = await run(tool, { action: "read", path: "src/app.ts" });
    expect(firstRead.details.cached).toBeUndefined();
    expect(firstRead.text).toContain("is now cached for the session");
    expect(secondRead.details.cached).toBe(true);
    expect(secondRead.details.cacheHitCount).toBe(1);
    expect(secondRead.text).toContain("cache hit");
    expect(thirdRead.details.cached).toBe(true);
    expect(thirdRead.details.cacheHitCount).toBe(2);
    expect(thirdRead.details.cacheReplaySuppressed).toBe(true);
    expect(thirdRead.text).toContain("duplicate guard");
    expect(thirdRead.text).not.toContain("export const value = 1");
    expect(targetReadFileCalls).toBe(1);

    const rangeRead = await run(tool, { action: "read", path: "src/app.ts", startLine: 1, endLine: 1 });
    const equivalentRangeRead = await run(tool, { action: "read", path: "src/app.ts", offset: 1, limit: 1 });
    expect(rangeRead.details.cached).toBeUndefined();
    expect(equivalentRangeRead.details.cached).toBe(true);
    expect(targetReadFileCalls).toBe(2);
  });

  it("stores large external reads as artifacts and keeps cache hits artifact-only", async () => {
    const root = await tempDir();
    await mkdir(path.join(root, "src"));
    const largeText = Array.from({ length: 600 }, (_, index) => `line ${index + 1} ${"x".repeat(40)}`).join("\n");
    await writeFile(path.join(root, "src", "large.txt"), largeText);
    const store = artifactStore();
    const cache = new Map();
    const [tool] = createExternalWorkspaceTools(settings(root), {
      runtime: runtime(),
      cache,
      artifactStore: store,
    });

    const first = await run(tool, { action: "read", path: "src/large.txt" });
    const second = await run(tool, { action: "read", path: "src/large.txt" });
    const third = await run(tool, { action: "read", path: "src/large.txt" });

    expect(store.writes).toHaveLength(1);
    expect(store.writes[0]).toMatchObject({
      label: "external://src/large.txt lines 1-600",
      sourceToolName: "external_inspect",
      sourceKind: "external",
      sourceUrl: "external://src/large.txt",
      pinned: true,
    });
    expect(store.writes[0].text).toContain("line 600");
    expect(first.details).toMatchObject({
      sourceArtifactId: "artifact-1",
      sourceArtifactCitation: "[external://src/large.txt lines 1-600](artifact:artifact-1)",
    });
    expect(first.text).toContain("[external://src/large.txt lines 1-600](artifact:artifact-1)");
    expect(first.text).not.toContain("line 600");
    expect(second.details.cached).toBe(true);
    expect(second.text).toContain("[external://src/large.txt lines 1-600](artifact:artifact-1)");
    expect(second.text).not.toContain("line 600");
    expect(third.details.cacheReplaySuppressed).toBe(true);
    expect(third.text).toContain("[external://src/large.txt lines 1-600](artifact:artifact-1)");
    expect(third.text).not.toContain("line 600");
  });

  it("maps absolute paths inside the configured root and rejects escapes", async () => {
    const root = await tempDir();
    await writeFile(path.join(root, "note.txt"), "safe");
    const outside = await tempDir();
    await writeFile(path.join(outside, "note.txt"), "outside");
    const tool = toolFor(root);

    await expect(run(tool, { action: "read", path: "../note.txt" })).rejects.toThrow(/cannot escape/i);
    await expect(run(tool, { action: "read", path: path.join(outside, "note.txt") })).rejects.toThrow(
      /inside the configured external root/i,
    );

    const listedRoot = await run(tool, { action: "list", path: root });
    expect(listedRoot.text).toContain("external://note.txt");

    const read = await run(tool, { action: "read", path: path.join(root, "note.txt") });
    expect(read.text).toContain("external://note.txt");
    expect(read.text).toContain("safe");
    expect(read.text).not.toContain(root);
  });

  it("uses external ignore defaults while allowing visible dot-directories", async () => {
    const root = await tempDir();
    await mkdir(path.join(root, ".github", "workflows"), { recursive: true });
    await mkdir(path.join(root, ".ssh"));
    await writeFile(path.join(root, ".github", "workflows", "ci.yml"), "name: ci\n");
    await writeFile(path.join(root, ".env"), "TOKEN=secret\n");
    await writeFile(path.join(root, "client.pem"), "secret\n");
    await writeFile(path.join(root, ".ssh", "config"), "Host *\n");
    const tool = toolFor(root);

    const listed = await run(tool, { action: "list", maxResults: 20 });
    expect(listed.text).toContain("external://.github/");
    expect(listed.text).not.toContain(".env");
    expect(listed.text).not.toContain("client.pem");
    expect(listed.text).not.toContain(".ssh");
    await expect(run(tool, { action: "read", path: ".env" })).rejects.toThrow(/ignored|hidden/i);

    const searched = await run(tool, { action: "search", query: "ci", kind: "content" });
    expect(searched.text).toContain("external://.github/workflows/ci.yml:1");
  });

  it("layers nested .gitignore rules with the external ignore list", async () => {
    const root = await tempDir();
    await mkdir(path.join(root, "dist"));
    await mkdir(path.join(root, "app", "generated"), { recursive: true });
    await writeFile(path.join(root, ".gitignore"), "dist/\n");
    await writeFile(path.join(root, "dist", "bundle.js"), "needle in build output\n");
    await writeFile(path.join(root, "app", ".gitignore"), "generated/\n");
    await writeFile(path.join(root, "app", "main.ts"), "needle in source\n");
    await writeFile(path.join(root, "app", "generated", "api.ts"), "needle in generated\n");
    const tool = toolFor(root);

    const searched = await run(tool, { action: "search", query: "needle", kind: "content", maxMatches: 10 });
    expect(searched.text).toContain("external://app/main.ts:1");
    expect(searched.text).not.toContain("bundle.js");
    expect(searched.text).not.toContain("generated/api.ts");
    await expect(run(tool, { action: "read", path: "app/generated/api.ts" })).rejects.toThrow(/ignored|hidden/i);

    const withoutGitignore = toolFor(root, { honorGitignore: false });
    const unfiltered = await run(withoutGitignore, { action: "search", query: "needle", kind: "content", maxMatches: 10 });
    expect(unfiltered.text).toContain("external://dist/bundle.js:1");
    expect(unfiltered.text).toContain("external://app/generated/api.ts:1");
  });

  it("does not follow symlinks outside the external root", async () => {
    const root = await tempDir();
    const outside = await tempDir();
    await writeFile(path.join(outside, "secret.txt"), "outside secret\n");
    await symlink(path.join(outside, "secret.txt"), path.join(root, "leak.txt"));
    const tool = toolFor(root);

    const listed = await run(tool, { action: "list" });
    expect(listed.text).not.toContain("leak.txt");
    await expect(run(tool, { action: "read", path: "leak.txt" })).rejects.toThrow(/outside the external root/i);
  });

  it("applies text and size guards", async () => {
    const root = await tempDir();
    await writeFile(path.join(root, "binary.bin"), new Uint8Array([65, 0, 66]));
    await writeFile(path.join(root, "large.txt"), "x".repeat(60_000));
    const tool = toolFor(root);

    const binary = await run(tool, { action: "read", path: "binary.bin" });
    expect(binary.text).toMatch(/binary/i);

    const large = await run(tool, { action: "read", path: "large.txt" });
    expect(large.text).toMatch(/large/i);
    expect(large.details.refused).toBe("bulk-too-large");
  });

  it("opens passive external:// references through the supplied desktop opener", async () => {
    const root = await tempDir();
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "app.ts"), "export {}\n");
    const opened: string[] = [];

    await expect(openExternalReference(settings(root), "external://src/app.ts", runtime(opened))).resolves.toBe(
      "Opened external://src/app.ts.",
    );
    expect(opened).toEqual([path.join(root, "src", "app.ts")]);
    expect(firstExternalReference("see external://src/app.ts.", 10)).toBe("external://src/app.ts");
  });
});
