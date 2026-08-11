import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { App, DataAdapter } from "obsidian";
import { DEFAULT_SETTINGS, type AgenticChatSettings } from "../src/settings";
import { AgentRuntimeResourceState } from "../src/agent/runtime-resource-state";
import { ReadMemo } from "../src/vault/read-memo";
import type { WebFetcher } from "../src/tools/web-fetch";
import type { ToolArtifactStoreLike } from "../src/artifacts/tool-artifact-store";
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
  await app.vault.createFolder(".agentic-plugins");
  await app.vault.createFolder(".agentic-plugins/tools");
  await app.vault.createFolder(".agentic-plugins/tools/skills");
  await app.vault.createFolder(".agentic-plugins/tools/skills/deep-research");
  await app.vault.create(
    ".agentic-plugins/tools/plugin.json",
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "tools",
      version: "1.0.0",
      description: "Vault tools",
    }),
  );
  await app.vault.create(
    ".agentic-plugins/tools/skills/deep-research/SKILL.md",
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
    const currentSettings = settings({ enableBuiltinAgents: true, mode: "plan" });
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
