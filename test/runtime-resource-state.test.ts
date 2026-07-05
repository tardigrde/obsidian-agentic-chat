import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { App, DataAdapter } from "obsidian";
import { DEFAULT_SETTINGS, type AgenticChatSettings } from "../src/settings";
import { AgentRuntimeResourceState } from "../src/agent/runtime-resource-state";
import { ReadMemo } from "../src/vault/read-memo";
import type { WebFetcher } from "../src/tools/web-fetch";
import type { ToolArtifactStoreLike, ToolArtifactWriteInput } from "../src/artifacts/tool-artifact-store";
import { FakeApp } from "./helpers/fake-vault";

function fakeAdapter(files: Record<string, string>): DataAdapter {
  return {
    exists: async (path: string) => path in files,
    read: async (path: string) => files[path] ?? "",
  } as unknown as DataAdapter;
}

type SettingsOverrides = Omit<Partial<AgenticChatSettings>, "web"> & {
  web?: Partial<AgenticChatSettings["web"]>;
  mcp?: Partial<AgenticChatSettings["mcp"]>;
};

function settings(overrides: SettingsOverrides = {}): AgenticChatSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...overrides,
    web: { ...DEFAULT_SETTINGS.web, ...(overrides.web ?? {}) },
    mcp: { ...DEFAULT_SETTINGS.mcp, ...(overrides.mcp ?? {}) },
  };
}

async function seededApp(): Promise<App> {
  const app = new FakeApp();
  await app.vault.createFolder("Skills");
  await app.vault.create(
    "Skills/deep.md",
    "---\nname: deep-research\ndescription: Custom deep research\n---\nCustom research body.",
  );
  (app.vault as unknown as { adapter: DataAdapter }).adapter = fakeAdapter({
    "AGENTS.md": "# Vault instructions\n- be precise",
  });
  return app as unknown as App;
}

const noopFetcher: WebFetcher = async () => ({ status: 200, text: "", headers: {} });
const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function tempDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "agentic-chat-runtime-"));
  tempRoots.push(root);
  return root;
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
        pinned: input.pinned === true,
      };
    },
    async readArtifact() {
      throw new Error("not implemented");
    },
  };
}

function makeState(app: App, currentSettings: AgenticChatSettings, store?: ToolArtifactStoreLike): {
  state: AgentRuntimeResourceState;
} {
  const state = new AgentRuntimeResourceState({
    app,
    getSettings: () => currentSettings,
    readMemo: new ReadMemo(),
    webFetch: noopFetcher,
    artifactStore: store,
  });
  return { state };
}

async function runTool(tool: AgentTool, params: unknown): Promise<{ details: Record<string, unknown> }> {
  const result = await tool.execute("call-1", params as never, undefined);
  return { details: (result.details ?? {}) as Record<string, unknown> };
}

describe("AgentRuntimeResourceState", () => {
  it("starts with empty resources and a permissive ignore matcher", async () => {
    const { state } = makeState(await seededApp(), settings());

    expect(state.getSkills()).toEqual([]);
    expect(state.getProfiles()).toEqual([]);
    expect(state.isPathIgnored("Private/secret.md")).toBe(false);
    expect(state.buildParentTools(settings()).map((tool) => tool.name)).not.toContain("subagent");
  });

  it("reloads skills, profiles, instructions, and ignore rules", async () => {
    const { state } = makeState(
      await seededApp(),
      settings({
        skillsFolder: "Skills",
        enableBuiltinAgents: true,
        ignoredGlobs: "Private/**",
        web: { enabled: true },
      }),
    );

    await state.reload();

    expect(state.getSkills().map((skill) => skill.name)).toContain("deep-research");
    expect(state.getProfiles().map((profile) => profile.name).sort()).toEqual(["editor", "researcher", "reviewer"]);
    expect(state.current.instructionsOverlay).toContain("# Vault instructions");
    expect(state.isPathIgnored("Private/secret.md")).toBe(true);
    expect(state.isPathIgnored("Notes/public.md")).toBe(false);
  });

  it("composes the system prompt with the current model identity and loaded resources", async () => {
    const currentSettings = settings({ skillsFolder: "Skills", enableBuiltinAgents: true, mode: "plan" });
    const { state } = makeState(
      await seededApp(),
      currentSettings,
    );
    await state.reload();

    const prompt = state.composeSystemPrompt(currentSettings, "test/model");

    expect(prompt).toContain('Identity: you are the "agentic-chat" Obsidian plugin.');
    expect(prompt).toContain('model "test/model"');
    expect(prompt).toContain("## Project instructions");
    expect(prompt).toContain("## Subagents");
    expect(prompt).toContain("deep-research");
    expect(prompt).toContain("read-only");
  });

  it("builds parent tools from the current resource snapshot", async () => {
    const { state } = makeState(
      await seededApp(),
      settings({ enableBuiltinAgents: true, web: { enabled: true } }),
    );
    await state.reload();
    const subagentTool = { name: "subagent", label: "Subagent" } as AgentTool;

    const toolNames = state
      .buildParentTools(settings({ web: { enabled: true } }), subagentTool)
      .map((tool) => tool.name);

    expect(toolNames).toEqual(expect.arrayContaining(["read", "vault_inspect", "write", "web_search", "fetch_url", "subagent"]));
  });

  it("registers external_inspect only when the external root is configured", async () => {
    const currentSettings = settings({
      external: {
        ...DEFAULT_SETTINGS.external,
        enabled: true,
        rootPath: "/workspace/code",
      },
    });
    const { state } = makeState(await seededApp(), currentSettings);
    await state.reload();

    expect(state.buildParentTools(currentSettings).map((tool) => tool.name)).toContain("external_inspect");
    expect(state.composeSystemPrompt(currentSettings, "test/model")).toContain("external://relative/path");
    expect(state.composeSystemPrompt(currentSettings, "test/model")).toContain("startLine/endLine");
    expect(state.composeSystemPrompt(currentSettings, "test/model")).toContain("Avoid repeating the same external_inspect");
    expect(state.composeSystemPrompt(currentSettings, "test/model")).not.toContain("/workspace/code");
  });

  it("keeps external_inspect cache across routine resource reloads within a session", async () => {
    const root = await tempDir();
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "app.ts"), "export const value = 1;\n");
    const currentSettings = settings({
      external: {
        ...DEFAULT_SETTINGS.external,
        enabled: true,
        rootPath: root,
      },
    });
    const previousRequire = (globalThis as { require?: unknown }).require;
    (globalThis as { require?: unknown }).require = createRequire(import.meta.url);
    try {
      const { state } = makeState(await seededApp(), currentSettings);
      await state.reload();
      const firstTool = state.buildParentTools(currentSettings).find((tool) => tool.name === "external_inspect");
      expect(firstTool).toBeTruthy();

      const first = await runTool(firstTool as AgentTool, { action: "read", path: "src/app.ts" });
      expect(first.details.cached).toBeUndefined();

      await state.reload();
      const secondTool = state.buildParentTools(currentSettings).find((tool) => tool.name === "external_inspect");
      expect(secondTool).toBeTruthy();
      const second = await runTool(secondTool as AgentTool, { action: "read", path: "src/app.ts" });
      expect(second.details.cached).toBe(true);

      state.clearSessionState();
      const afterResetTool = state.buildParentTools(currentSettings).find((tool) => tool.name === "external_inspect");
      expect(afterResetTool).toBeTruthy();
      const afterReset = await runTool(afterResetTool as AgentTool, { action: "read", path: "src/app.ts" });
      expect(afterReset.details.cached).toBeUndefined();
    } finally {
      if (previousRequire === undefined) {
        delete (globalThis as { require?: unknown }).require;
      } else {
        (globalThis as { require?: unknown }).require = previousRequire;
      }
    }
  });

  it("passes the artifact store into parent external_inspect tools", async () => {
    const root = await tempDir();
    await mkdir(path.join(root, "src"));
    await writeFile(
      path.join(root, "src", "large.txt"),
      Array.from({ length: 600 }, (_, index) => `line ${index + 1} ${"x".repeat(40)}`).join("\n"),
    );
    const currentSettings = settings({
      external: {
        ...DEFAULT_SETTINGS.external,
        enabled: true,
        rootPath: root,
      },
    });
    const store = artifactStore();
    const previousRequire = (globalThis as { require?: unknown }).require;
    (globalThis as { require?: unknown }).require = createRequire(import.meta.url);
    try {
      const { state } = makeState(await seededApp(), currentSettings, store);
      await state.reload();
      const tool = state.buildParentTools(currentSettings).find((item) => item.name === "external_inspect");
      expect(tool).toBeTruthy();

      const result = await runTool(tool as AgentTool, { action: "read", path: "src/large.txt" });

      expect(store.writes).toHaveLength(1);
      expect(store.writes[0]).toMatchObject({ sourceToolName: "external_inspect", pinned: true });
      expect(result.details).toMatchObject({ sourceArtifactId: "artifact-1" });
    } finally {
      if (previousRequire === undefined) {
        delete (globalThis as { require?: unknown }).require;
      } else {
        (globalThis as { require?: unknown }).require = previousRequire;
      }
    }
  });

  it("drops optional parent tools when tool schemas exceed the budget threshold", async () => {
    const currentSettings = settings({ enableBuiltinAgents: true, web: { enabled: true } });
    const { state } = makeState(await seededApp(), currentSettings);
    await state.reload();
    const subagentTool = { name: "subagent", label: "Subagent" } as AgentTool;

    const dropped = state
      .buildParentTools(currentSettings, subagentTool, { contextWindow: 1_000 })
      .map((tool) => tool.name);

    expect(dropped).toEqual(expect.arrayContaining(["read", "vault_inspect", "write"]));
    expect(dropped).not.toContain("web_search");
    expect(dropped).not.toContain("fetch_url");
    expect(dropped).not.toContain("subagent");
    expect(state.getToolBudgetSnapshot()).toMatchObject({
      active: true,
      contextWindow: 1_000,
      droppedTools: [
        { name: "web_search", reason: "web egress" },
        { name: "fetch_url", reason: "web egress" },
        { name: "subagent", reason: "subagent delegation" },
      ],
    });
    expect(state.getToolBudgetSnapshot().triggeredAtToolSchemaPercent).toBeGreaterThanOrEqual(2);

    const restored = state
      .buildParentTools(currentSettings, subagentTool, { contextWindow: 1_000_000 })
      .map((tool) => tool.name);

    expect(restored).toEqual(expect.arrayContaining(["web_search", "fetch_url", "subagent"]));
    expect(state.getToolBudgetSnapshot()).toMatchObject({ active: false, droppedTools: [] });
  });
});
