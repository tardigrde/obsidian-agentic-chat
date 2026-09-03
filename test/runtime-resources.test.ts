import { describe, expect, it } from "vitest";
import type { AgentTool, Skill } from "@earendil-works/pi-agent-core";
import type { App, DataAdapter } from "obsidian";
import { ReadMemo } from "../src/vault/read-memo";
import { DEFAULT_SETTINGS, type AgenticChatSettings } from "../src/settings";
import {
  buildAgentParentTools,
  composeAgentSystemPrompt,
  EMPTY_AGENT_RUNTIME_RESOURCES,
  loadAgentRuntimeResources,
  type AgentRuntimeResources,
} from "../src/agent/runtime-resources";
import type { ToolArtifactStoreLike } from "../src/artifacts/tool-artifact-store";
import type { WebFetcher } from "../src/tools/web-fetch";
import { createMcpServerSettings } from "../src/mcp/settings";
import { pluginMcpServerId } from "../src/plugins/loader";
import { FakeApp } from "./helpers/fake-vault";

/** A persisted, user-enabled record for the seeded mcp-server plugin. */
function enabledPluginServer(): ReturnType<typeof createMcpServerSettings> {
  return {
    ...createMcpServerSettings({
      id: pluginMcpServerId("mcp-server", "docs"),
      name: "mcp-server: docs",
      url: "https://mcp.example.com/mcp",
      enabled: true,
    }),
    source: "plugin",
    pluginRoot: ".agentic-plugins/mcp-server",
    headers: {},
  };
}

function fakeAdapter(files: Record<string, string>): DataAdapter {
  return {
    exists: async (path: string) => path in files,
    read: async (path: string) => files[path] ?? "",
  } as unknown as DataAdapter;
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
      description: "Demo tools",
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
  it("loads plugin skills, built-ins, profiles, instructions, and ignore rules", async () => {
    const resources = await loadAgentRuntimeResources(
      await seededApp(),
      settings({
        ignoredGlobs: "Private/**",
        web: { enabled: true },
      }),
    );

    expect(resources.skills.map((skill) => skill.name)).toContain("deep-research");
    expect(resources.skills.map((skill) => skill.name)).toContain("self-knowledge");
    // Plugin skills win over built-ins of the same name.
    expect(resources.skills.find((skill) => skill.name === "deep-research")?.filePath).toBe(
      ".agentic-plugins/tools/skills/deep-research/SKILL.md",
    );
    expect(resources.profiles.map((profile) => profile.name).sort()).toEqual(["explorer"]);
    expect(resources.instructionsOverlay).toContain("## Project instructions");
    expect(resources.instructionsOverlay).toContain("# Vault instructions");
    expect(resources.ignoreMatcher("Private/secret.md")).toBe(true);
    expect(resources.ignoreMatcher("Notes/public.md")).toBe(false);
  });

  it("composes the system prompt from a loaded resource snapshot", async () => {
    const resources = await loadAgentRuntimeResources(
      await seededApp(),
      settings(),
    );

    const prompt = composeAgentSystemPrompt(settings({ mode: "plan" }), resources, "Identity: test agent.");

    expect(prompt).toContain("Identity: test agent.");
    expect(prompt).toContain("## Project instructions");
    expect(prompt).toContain("## Subagents");
    expect(prompt).toContain("deep-research");
    expect(prompt).toContain("read-only");
  });

  it("marks plugin-contributed skill bodies as untrusted in the system prompt", async () => {
    const resources = await loadAgentRuntimeResources(await seededApp(), settings());
    const prompt = composeAgentSystemPrompt(settings(), resources, "");
    expect(prompt).toContain("SECURITY BOUNDARY");
    expect(prompt).toMatch(/untrusted content/i);
  });

  it("does not flag first-party packages (builtins/legacy-skills) as untrusted", () => {
    const skill: Skill = { name: "my-skill", description: "d", content: "body", filePath: "pkg" };
    const resources: AgentRuntimeResources = {
      ...EMPTY_AGENT_RUNTIME_RESOURCES,
      plugins: [
        { name: "builtins", enabled: true, skills: [skill], mcpServers: [], reports: [], skillReports: [] } as never,
        { name: "legacy-skills", enabled: true, skills: [skill], mcpServers: [], reports: [], skillReports: [] } as never,
      ],
    };
    expect(composeAgentSystemPrompt(settings(), resources, "")).not.toContain("SECURITY BOUNDARY");
  });

  it("builds parent tools from the loaded resource snapshot", () => {
    const resources: AgentRuntimeResources = {
      skills: [],
      plugins: [],
      profiles: [],
      instructionsOverlay: "",
      ignoreMatcher: () => false,
      mcpTools: [],
      mcpDiagnostics: [],
    };
    const subagentTool = { name: "subagent", label: "Subagent" } as AgentTool;
    const { tools } = buildAgentParentTools({
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
        "vault_inspect",
        "write",
        "ask_user",
        "search_memory",
        "import_pdf",
        "web_search",
        "fetch_url",
        "read_artifact",
        "search_artifact",
        "subagent",
      ]),
    );
  });

  it("includes discovered MCP tools from plugins in the parent tool snapshot", async () => {
    const app = await seededApp();
    await app.vault.createFolder(".agentic-plugins/mcp-server");
    await app.vault.create(
      ".agentic-plugins/mcp-server/plugin.json",
      JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name: "mcp-server",
      }),
    );
    await app.vault.create(
      ".agentic-plugins/mcp-server/mcp.json",
      JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        mcpServers: { docs: { type: "streamable-http", url: "https://mcp.example.com/mcp" } },
      }),
    );
    const resources = await loadAgentRuntimeResources(
      app,
      settings({ mcp: { enabled: true, proxyUrl: "", noProxy: "localhost,127.0.0.1,::1", servers: [enabledPluginServer()] } }),
      mcpFetcher(),
    );

    const { tools } = buildAgentParentTools({
      app: { vault: {}, workspace: {} } as unknown as App,
      settings: settings({ mcp: { enabled: true, proxyUrl: "", noProxy: "localhost,127.0.0.1,::1", servers: [] } }),
      resources,
      readMemo: new ReadMemo(),
      webFetch: noopFetcher,
    });

    expect(tools.map((tool) => tool.name)).toContain(`mcp__${enabledPluginServer().id}__resolve_library_id`);
  });

  it("keeps MCP discovery failures from plugin servers in runtime diagnostics", async () => {
    const app = await seededApp();
    await app.vault.createFolder(".agentic-plugins/mcp-server");
    await app.vault.create(
      ".agentic-plugins/mcp-server/plugin.json",
      JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name: "mcp-server",
      }),
    );
    await app.vault.create(
      ".agentic-plugins/mcp-server/mcp.json",
      JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        mcpServers: { docs: { type: "streamable-http", url: "https://mcp.example.com/mcp" } },
      }),
    );
    const resources = await loadAgentRuntimeResources(
      app,
      settings({ mcp: { enabled: true, proxyUrl: "", noProxy: "localhost,127.0.0.1,::1", servers: [enabledPluginServer()] } }),
      async () => ({ status: 500, text: "server down", headers: {} }),
    );

    expect(resources.mcpTools).toEqual([]);
    expect(resources.mcpDiagnostics).toEqual([
      expect.objectContaining({
        serverId: enabledPluginServer().id,
        serverName: "mcp-server: docs",
        status: "error",
        toolCount: 0,
        error: expect.stringMatching(/HTTP 500/),
      }),
    ]);
  });
});
