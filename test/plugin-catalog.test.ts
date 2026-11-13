import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import { DEFAULT_SETTINGS, type AgenticChatSettings } from "../src/settings-schema";
import { PluginService } from "../src/plugins/service";
import type { LoadedPlugin } from "../src/plugins/loader";
import { AgentRuntimeResourceState } from "../src/agent/runtime-resource-state";
import { loadAgentRuntimeResources } from "../src/agent/runtime-resources";
import { ReadMemo } from "../src/vault/read-memo";
import type { WebFetcher } from "../src/tools/web-fetch";
import { FakeApp } from "./helpers/fake-vault";

const noopFetcher: WebFetcher = async () => ({ status: 200, text: "", headers: {} });

function settings(): AgenticChatSettings {
  return {
    ...DEFAULT_SETTINGS,
    plugins: { ...DEFAULT_SETTINGS.plugins, enabled: {}, sources: {}, mcpState: {} },
    mcp: { ...DEFAULT_SETTINGS.mcp, servers: [] },
    approval: { ...DEFAULT_SETTINGS.approval, perTool: {} },
  };
}

async function waitFor(check: () => boolean, attempts = 100): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition not met");
}

function fakePlugin(overrides: Partial<LoadedPlugin> = {}): LoadedPlugin {
  return {
    rootPath: ".somewhere/tools",
    name: "injected",
    enabled: true,
    manifestProblem: null,
    skills: [{ name: "from-injected", description: "d", content: "body", filePath: "injected" }],
    skillReports: [],
    mcpValidation: null,
    mcpServers: [],
    reports: [],
    auditStatus: "ok",
    ...overrides,
  };
}

describe("one plugin catalog", () => {
  it("builds runtime resources from an injected plugin list without scanning the folder", async () => {
    const app = new FakeApp() as unknown as App;
    const injected = [fakePlugin()];

    const resources = await loadAgentRuntimeResources(
      app,
      settings(),
      undefined,
      undefined,
      undefined,
      injected,
    );

    expect(resources.plugins).toBe(injected);
    expect(resources.skills.map((skill) => skill.name)).toContain("from-injected");
  });

  it("invalidating the catalog refreshes the runtime without an unrelated reload", async () => {
    const app = new FakeApp();
    await app.vault.createFolder(".agentic-plugins");
    const current = settings();
    const service = new PluginService(app as unknown as App, () => current, () => {});
    const state = new AgentRuntimeResourceState({
      app: app as unknown as App,
      getSettings: () => current,
      readMemo: new ReadMemo(),
      webFetch: noopFetcher,
      plugins: service,
    });
    const unsubscribe = service.onInvalidated(() => {
      void state.reload();
    });
    try {
      await state.reload();
      expect(state.current.plugins).toEqual([]);

      // The install path ends with invalidate(); no other reload call follows.
      await service.scaffoldSkill({ name: "late", description: "Arrives late", body: "# late" });

      await waitFor(() => state.current.plugins.some((plugin) => plugin.name === "late"));
      expect(state.current.plugins.map((plugin) => plugin.name)).toEqual(["late"]);
      expect(state.getSkills().map((skill) => skill.name)).toContain("late");
    } finally {
      unsubscribe();
    }
  });
});

describe("runtime reads the catalog without pruning", () => {
  it("never calls the service reload, which prunes settings and saves", async () => {
    const app = new FakeApp();
    await app.vault.createFolder(".agentic-plugins");
    const current = settings();
    const service = new PluginService(app as unknown as App, () => current, () => {});
    let reloads = 0;
    const realReload = service.reload.bind(service);
    service.reload = async () => {
      reloads += 1;
      return realReload();
    };
    const state = new AgentRuntimeResourceState({
      app: app as unknown as App,
      getSettings: () => current,
      readMemo: new ReadMemo(),
      webFetch: noopFetcher,
      plugins: service,
    });

    await state.reload();
    service.invalidate();
    await state.reload();

    expect(reloads).toBe(0);
  });
});
