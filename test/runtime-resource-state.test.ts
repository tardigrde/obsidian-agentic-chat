import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { App, DataAdapter } from "obsidian";
import { DEFAULT_SETTINGS, type AgenticChatSettings } from "../src/settings-schema";
import { AgentRuntimeResourceState } from "../src/agent/runtime-resource-state";
import { ReadMemo } from "../src/vault/read-memo";
import type { WebFetcher } from "../src/tools/web-fetch";
import type { ToolArtifactStoreLike } from "../src/artifacts/tool-artifact-store";
import { FakeApp } from "./helpers/fake-vault";
import { fakeAdapter } from "./support/fake-adapter";

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

/** Construction only: the tools under test never touch the store. */
function fakeStore(): ToolArtifactStoreLike {
  return {} as ToolArtifactStoreLike;
}

function makeState(
  app: App,
  currentSettings: AgenticChatSettings,
  store?: ToolArtifactStoreLike,
  now?: () => Date,
): {
  state: AgentRuntimeResourceState;
} {
  const state = new AgentRuntimeResourceState({
    app,
    getSettings: () => currentSettings,
    readMemo: new ReadMemo(),
    webFetch: noopFetcher,
    artifactStore: store,
    now,
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
        ignoredGlobs: "Private/**",
        web: { enabled: true },
      }),
    );

    await state.reload();

    expect(state.getSkills().map((skill) => skill.name)).toContain("deep-research");
    expect(state.getProfiles().map((profile) => profile.name).sort()).toEqual(["explorer"]);
    expect(state.current.instructionsOverlay).toContain("# Vault instructions");
    expect(state.isPathIgnored("Private/secret.md")).toBe(true);
    expect(state.isPathIgnored("Notes/public.md")).toBe(false);
  });

  it("composes the system prompt with the current model identity and loaded resources", async () => {
    const currentSettings = settings();
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
  });

  it("builds parent tools from the current resource snapshot", async () => {
    const { state } = makeState(
      await seededApp(),
      settings({ web: { enabled: true } }),
    );
    await state.reload();
    const subagentTool = { name: "subagent", label: "Subagent" } as AgentTool;

    const toolNames = state
      .buildParentTools(settings({ web: { enabled: true } }), subagentTool)
      .map((tool) => tool.name);

    expect(toolNames).toEqual(expect.arrayContaining(["read", "vault_inspect", "write", "web_search", "fetch_url", "subagent"]));
  });


  it("keeps the date out of the system prompt and always loads current_time", async () => {
    // A date line in the prompt cost correctness in the core eval A/B (ADR 0006),
    // so the model gets the date from the always-loaded current_time tool.
    const currentSettings = settings();
    const fixed = new Date(2026, 10, 16, 14, 37, 5);
    const { state } = makeState(await seededApp(), currentSettings, undefined, () => fixed);
    await state.reload();

    const prompt = state.composeSystemPrompt(currentSettings, "test/model");
    expect(prompt).not.toContain("2026-11-16");
    expect(prompt).not.toMatch(/Today is/);
    expect(prompt).not.toContain("- current_time:");

    const tools = state.buildParentTools(currentSettings);
    const clock = tools.find((tool) => tool.name === "current_time");
    expect(clock).toBeDefined();
    const result = await clock?.execute("call-1", {} as never);
    expect(JSON.stringify(result?.content)).toContain("2026-11-16 14:37:05 (Monday)");
  });

  it("lists the deferred catalog in the prompt and keeps the prompt unchanged when a tool loads", async () => {
    const currentSettings = settings();
    const { state } = makeState(await seededApp(), currentSettings, fakeStore());
    await state.reload();
    const before = state.composeSystemPrompt(currentSettings, "test/model");
    expect(before).toContain("## Deferred tools");
    expect(before).toContain("- import_document:");

    const search = state.buildParentTools(currentSettings).find((tool) => tool.name === "search_tools");
    await search?.execute("call-1", { query: "import document" } as never);

    expect(state.getLoadedToolNames()).toEqual(["import_document"]);
    expect(state.composeSystemPrompt(currentSettings, "test/model")).toBe(before);
  });

  it("loads a searched tool for the next step and keeps it on later rebuilds", async () => {
    const currentSettings = settings();
    const { state } = makeState(await seededApp(), currentSettings, fakeStore());
    await state.reload();
    const first = state.buildParentTools(currentSettings);
    expect(first.map((tool) => tool.name)).not.toContain("import_document");

    const search = first.find((tool) => tool.name === "search_tools");
    const result = await search?.execute("call-1", { query: "extract text from a PDF" } as never);
    expect(result?.details).toMatchObject({ loaded: ["import_document"] });

    const next = state.toolsForNextStep(first, []);
    expect(next?.map((tool) => tool.name)).toContain("import_document");
    // Nothing new to load: no change for the step after.
    expect(state.toolsForNextStep(next ?? [], [])).toBeUndefined();
    // A refresh before the next prompt keeps the loaded tool.
    expect(state.buildParentTools(currentSettings).map((tool) => tool.name)).toContain("import_document");
    // A different session starts without it.
    state.clearSessionState([]);
    expect(state.buildParentTools(currentSettings).map((tool) => tool.name)).not.toContain("import_document");
  });

  it("loads a deferred tool after a direct call failed because it was not loaded", async () => {
    const currentSettings = settings();
    const { state } = makeState(await seededApp(), currentSettings, fakeStore());
    await state.reload();
    const first = state.buildParentTools(currentSettings);

    const next = state.toolsForNextStep(first, [
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "import_document",
        content: [{ type: "text", text: "Tool import_document not found" }],
        isError: true,
        timestamp: 1,
      },
      {
        role: "toolResult",
        toolCallId: "call-2",
        toolName: "mcp__ghost__tool",
        content: [{ type: "text", text: "Tool mcp__ghost__tool not found" }],
        isError: true,
        timestamp: 2,
      },
    ] as never);

    expect(next?.map((tool) => tool.name)).toContain("import_document");
    expect(state.getLoadedToolNames()).toEqual(["import_document"]);
  });

  it("restores the loaded tools of a reopened session from its transcript", async () => {
    const currentSettings = settings();
    const { state } = makeState(await seededApp(), currentSettings, fakeStore());
    await state.reload();

    state.clearSessionState([
      { role: "user", content: "import my PDF", timestamp: 1 },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "search_tools",
        content: [{ type: "text", text: "Loaded 1 tool(s)." }],
        details: { query: "import document", loaded: ["import_document"] },
        isError: false,
        timestamp: 2,
      },
    ] as never);

    expect(state.buildParentTools(currentSettings).map((tool) => tool.name)).toContain("import_document");
  });
});
