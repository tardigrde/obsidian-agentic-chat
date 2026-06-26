import { describe, expect, it } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { App, DataAdapter } from "obsidian";
import { DEFAULT_SETTINGS, type AgenticChatSettings } from "../src/settings";
import { AgentRuntimeResourceState } from "../src/agent/runtime-resource-state";
import { ReadMemo } from "../src/vault/read-memo";
import type { WebFetcher } from "../src/tools/web-fetch";
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

function makeState(app: App, currentSettings: AgenticChatSettings): {
  state: AgentRuntimeResourceState;
} {
  const state = new AgentRuntimeResourceState({
    app,
    getSettings: () => currentSettings,
    readMemo: new ReadMemo(),
    webFetch: noopFetcher,
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

    expect(toolNames).toEqual(expect.arrayContaining(["read", "write", "web_search", "fetch_url", "subagent"]));
  });
});
