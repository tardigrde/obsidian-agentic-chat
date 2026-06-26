import { describe, expect, it } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { App, DataAdapter } from "obsidian";
import { ReadMemo } from "../src/vault/read-memo";
import { DEFAULT_SETTINGS, type AgenticChatSettings } from "../src/settings";
import { createMcpServerSettings } from "../src/mcp/settings";
import {
  buildAgentParentTools,
  composeAgentSystemPrompt,
  loadAgentRuntimeResources,
  type AgentRuntimeResources,
} from "../src/agent/runtime-resources";
import type { ToolArtifactStoreLike } from "../src/artifacts/tool-artifact-store";
import type { WebFetcher } from "../src/tools/web-fetch";
import { FakeApp } from "./helpers/fake-vault";

function fakeAdapter(files: Record<string, string>): DataAdapter {
  return {
    exists: async (path: string) => path in files,
    read: async (path: string) => files[path] ?? "",
  } as unknown as DataAdapter;
}

async function seededApp(): Promise<App> {
  const app = new FakeApp();
  await app.vault.createFolder("Skills");
  await app.vault.createFolder("Templates");
  await app.vault.create(
    "Skills/deep.md",
    "---\nname: deep-research\ndescription: Custom deep research\n---\nCustom research body.",
  );
  await app.vault.create(
    "Templates/legacy.md",
    "---\nname: Legacy\ndescription: Legacy template\n---\nLegacy body.",
  );
  (app.vault as unknown as { adapter: DataAdapter }).adapter = fakeAdapter({
    "AGENTS.md": "# Vault instructions\n- be precise",
  });
  return app as unknown as App;
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

const noopFetcher: WebFetcher = async () => ({ status: 200, text: "", headers: {} });
const noopArtifactStore: ToolArtifactStoreLike = {
  async writeArtifact(input) {
    return {
      id: "artifact-1",
      label: input.label,
      sourceToolName: input.sourceToolName,
      contentType: input.contentType ?? "text/plain",
      createdAt: "2026-06-24T00:00:00.000Z",
      charLength: input.text.length,
    };
  },
  async readArtifact() {
    return {
      metadata: {
        id: "artifact-1",
        label: "Artifact",
        sourceToolName: "tool",
        contentType: "text/plain",
        createdAt: "2026-06-24T00:00:00.000Z",
        charLength: 0,
      },
      text: "",
    };
  },
};

function mcpFetcher(): WebFetcher {
  const responses = [
    { status: 200, text: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-11-25" } }), headers: {} },
    { status: 202, text: "", headers: {} },
    {
      status: 200,
      text: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result: { tools: [{ name: "resolve-library-id", inputSchema: { type: "object", properties: {} } }] },
      }),
      headers: {},
    },
  ];
  return async () => responses.shift() ?? { status: 500, text: "unexpected", headers: {} };
}

describe("agent runtime resources", () => {
  it("loads skills, legacy templates, built-ins, profiles, instructions, and ignore rules", async () => {
    const resources = await loadAgentRuntimeResources(
      await seededApp(),
      settings({
        skillsFolder: "Skills",
        templatesFolder: "Templates",
        enableBuiltinAgents: true,
        ignoredGlobs: "Private/**",
        web: { enabled: true },
      }),
    );

    expect(resources.skills.map((skill) => skill.name)).toContain("deep-research");
    expect(resources.skills.map((skill) => skill.name)).toContain("Legacy");
    // Vault skills are loaded before built-ins, so a vault skill with the same
    // name shadows the built-in skill.
    expect(resources.skills.find((skill) => skill.name === "deep-research")?.filePath).toBe("Skills/deep.md");
    expect(resources.profiles.map((profile) => profile.name).sort()).toEqual(["editor", "researcher", "reviewer"]);
    expect(resources.instructionsOverlay).toContain("## Project instructions");
    expect(resources.instructionsOverlay).toContain("# Vault instructions");
    expect(resources.ignoreMatcher("Private/secret.md")).toBe(true);
    expect(resources.ignoreMatcher("Notes/public.md")).toBe(false);
  });

  it("composes the system prompt from a loaded resource snapshot", async () => {
    const resources = await loadAgentRuntimeResources(
      await seededApp(),
      settings({ skillsFolder: "Skills", enableBuiltinAgents: true }),
    );

    const prompt = composeAgentSystemPrompt(settings({ mode: "plan" }), resources, "Identity: test agent.");

    expect(prompt).toContain("Identity: test agent.");
    expect(prompt).toContain("## Project instructions");
    expect(prompt).toContain("## Subagents");
    expect(prompt).toContain("deep-research");
    expect(prompt).toContain("read-only");
  });

  it("builds parent tools from the loaded resource snapshot", () => {
    const resources: AgentRuntimeResources = {
      skills: [],
      profiles: [],
      instructionsOverlay: "",
      ignoreMatcher: () => false,
      mcpTools: [],
      mcpDiagnostics: [],
    };
    const subagentTool = { name: "subagent", label: "Subagent" } as AgentTool;
    const tools = buildAgentParentTools({
      app: { vault: {}, workspace: {} } as unknown as App,
      settings: settings({ web: { enabled: true } }),
      resources,
      readMemo: new ReadMemo(),
      webFetch: noopFetcher,
      artifactStore: noopArtifactStore,
      askUser: async () => "answer",
      subagentTool,
    });

    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "read",
        "write",
        "ask_user",
        "web_search",
        "fetch_url",
        "read_artifact",
        "search_artifact",
        "subagent",
      ]),
    );
  });

  it("includes discovered MCP tools in the parent tool snapshot", async () => {
    const resources = await loadAgentRuntimeResources(
      await seededApp(),
      settings({
        mcp: {
          enabled: true,
          proxyUrl: "",
          noProxy: "localhost,127.0.0.1,::1",
          servers: [
            {
              ...createMcpServerSettings({ id: "docs", name: "Docs MCP", url: "https://mcp.example.com/mcp" }),
              approval: "ask",
            },
          ],
        },
      }),
      mcpFetcher(),
    );

    const tools = buildAgentParentTools({
      app: { vault: {}, workspace: {} } as unknown as App,
      settings: settings(),
      resources,
      readMemo: new ReadMemo(),
      webFetch: noopFetcher,
    });

    expect(tools.map((tool) => tool.name)).toContain("mcp__docs__resolve_library_id");
  });

  it("keeps MCP discovery failures in runtime diagnostics", async () => {
    const resources = await loadAgentRuntimeResources(
      await seededApp(),
      settings({
        mcp: {
          enabled: true,
          proxyUrl: "",
          noProxy: "localhost,127.0.0.1,::1",
          servers: [{ ...createMcpServerSettings({ id: "docs", name: "Docs MCP", url: "https://mcp.example.com/mcp" }), approval: "ask" }],
        },
      }),
      async () => ({ status: 500, text: "server down", headers: {} }),
    );

    expect(resources.mcpTools).toEqual([]);
    expect(resources.mcpDiagnostics).toEqual([
      expect.objectContaining({
        serverId: "docs",
        serverName: "Docs MCP",
        status: "error",
        toolCount: 0,
        error: expect.stringMatching(/HTTP 500/),
      }),
    ]);
  });
});
