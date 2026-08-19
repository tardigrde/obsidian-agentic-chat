import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import { DEFAULT_SETTINGS, type AgenticChatSettings } from "../src/settings";
import { PluginService } from "../src/plugins/service";
import { pluginMcpServerId } from "../src/plugins/loader";
import { AGENT_PLUGINS_SCHEMA_ID } from "../src/plugins/manifest";
import { FakeApp, FakeVault } from "./helpers/fake-vault";
import { gzipSync } from "../src/vendor/fflate";

async function seed(): Promise<{ app: App; vault: FakeVault }> {
  const app = new FakeApp();
  await app.vault.createFolder(".agentic-plugins");
  return { app: app as unknown as App, vault: app.vault };
}

function settings(overrides: Partial<AgenticChatSettings> = {}): AgenticChatSettings {
  return {
    ...DEFAULT_SETTINGS,
    plugins: { ...DEFAULT_SETTINGS.plugins, enabled: {} },
    mcp: { ...DEFAULT_SETTINGS.mcp, servers: [] },
    ...overrides,
  };
}

function serviceFor(app: App, current: AgenticChatSettings, onSave?: () => void | Promise<void>) {
  return new PluginService(app, () => current, onSave);
}

const ENCODER = new TextEncoder();

function claudePluginTree(): Map<string, Uint8Array> {
  return new Map(
    Object.entries({
      ".claude-plugin/plugin.json": JSON.stringify({
        name: "docs-helper",
        displayName: "Docs Helper",
        version: "2.1.0",
        description: "Write better docs.",
        mcpServers: {
          files: { type: "http", url: "https://mcp.example.com/mcp", headersHelper: "helper.js", headers: { "x-a": "b" } },
          local: { type: "stdio", command: "npx", args: ["foo"] },
        },
      }),
      "skills/docs-helper/SKILL.md": "---\nname: docs-helper\ndescription: D\nmetadata: {v: 1}\n---\n# Docs\n",
      "skills/docs-helper/references/style.md": "# Style guide",
      "commands/format.md": "# /format",
      "README.md": "# readme",
    }).map(([path, text]) => [path, ENCODER.encode(text)]),
  );
}

describe("PluginService.installFromTree", () => {
  it("converts a Claude plugin into a loadable Agent Plugins package", async () => {
    const { app, vault } = await seed();
    const current = settings();
    const service = serviceFor(app, current);
    const result = await service.installFromTree(claudePluginTree(), "github:example/docs-helper");

    expect(result).toMatchObject({
      rootPath: ".agentic-plugins/docs-helper",
      name: "docs-helper",
      updated: false,
      skills: 1,
      mcpServers: 1,
    });
    const manifest = JSON.parse(vault.contentOf(".agentic-plugins/docs-helper/plugin.json") as string);
    expect(manifest).toMatchObject({ $schema: AGENT_PLUGINS_SCHEMA_ID, name: "docs-helper", version: "2.1.0" });
    expect(manifest.displayName).toBeUndefined();
    expect(vault.contentOf(".agentic-plugins/docs-helper/skills/docs-helper/SKILL.md")).toContain("name: \"docs-helper\"");
    expect(vault.contentOf(".agentic-plugins/docs-helper/skills/docs-helper/references/style.md")).toBe("# Style guide");
    expect(vault.contentOf(".agentic-plugins/docs-helper/README.md")).toBe("# readme");
    expect(app.vault.getAbstractFileByPath(".agentic-plugins/docs-helper/commands/format.md")).toBeNull();

    const mcp = JSON.parse(vault.contentOf(".agentic-plugins/docs-helper/mcp.json") as string);
    expect(mcp.mcpServers.files).toMatchObject({ type: "streamable-http", url: "https://mcp.example.com/mcp" });
    expect(mcp.mcpServers.files.headersHelper).toBeUndefined();
    expect(mcp.mcpServers.local).toBeUndefined();
    expect(result.warnings.some((w) => w.includes("stdio"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("headersHelper"))).toBe(true);
  });

  it("slugs a foreign display name so the installed package passes its own validation", async () => {
    const { app, vault } = await seed();
    const current = settings();
    const service = serviceFor(app, current);
    const tree = new Map<string, Uint8Array>([
      [
        ".claude-plugin/plugin.json",
        ENCODER.encode(JSON.stringify({ name: "My Awesome Plugin", version: "1.0.0", mcpServers: {} })),
      ],
      ["skills/my-awesome-plugin/SKILL.md", ENCODER.encode("---\nname: my-awesome-plugin\ndescription: D\n---\nBody")],
    ]);
    const result = await service.installFromTree(tree, "github:example/my-awesome-plugin");

    expect(result.name).toBe("my-awesome-plugin");
    const manifest = JSON.parse(vault.contentOf(".agentic-plugins/my-awesome-plugin/plugin.json") as string);
    expect(manifest.name).toBe("my-awesome-plugin");
    const plugins = await service.reload();
    expect(plugins[0]).toMatchObject({ name: "my-awesome-plugin", auditStatus: "ok" });
    expect(plugins[0]?.skills.map((skill) => skill.name)).toEqual(["my-awesome-plugin"]);
    expect(current.plugins.sources["my-awesome-plugin"]).toBe("github:example/my-awesome-plugin");
  });

  it("records the source label and persists imported MCP servers disabled by default", async () => {
    const { app } = await seed();
    const current = settings();
    const service = serviceFor(app, current);
    await service.installFromTree(claudePluginTree(), "github:example/docs-helper");

    expect(current.plugins.sources["docs-helper"]).toBe("github:example/docs-helper");
    const server = current.mcp.servers.find((s) => s.source === "plugin");
    expect(server?.enabled).toBe(false);
    expect(server?.id).toBe(pluginMcpServerId("docs-helper", "files"));
  });

  it("re-importing the same name updates the package in place", async () => {
    const { app, vault } = await seed();
    const current = settings();
    const service = serviceFor(app, current);
    const first = await service.installFromTree(claudePluginTree(), "github:example/docs-helper");
    expect(first.updated).toBe(false);

    const secondTree = claudePluginTree();
    secondTree.set(".claude-plugin/plugin.json", ENCODER.encode(JSON.stringify({ name: "docs-helper", version: "3.0.0" })));
    const second = await service.installFromTree(secondTree, "github:example/docs-helper");
    expect(second.updated).toBe(true);
    const manifest = JSON.parse(vault.contentOf(".agentic-plugins/docs-helper/plugin.json") as string);
    expect(manifest.version).toBe("3.0.0");
  });

  it("installs a bare single-skill tree under a skills folder", async () => {
    const { app, vault } = await seed();
    const current = settings();
    const service = serviceFor(app, current);
    await service.installFromTree(
      new Map([["skills/my-skill/SKILL.md", ENCODER.encode("---\nname: my-skill\ndescription: D\n---\nBody")]]),
      "local folder",
    );
    expect(vault.contentOf(".agentic-plugins/my-skill/skills/my-skill/SKILL.md")).toContain("name: \"my-skill\"");
    const plugins = await service.reload();
    expect(plugins).toHaveLength(1);
    expect(plugins[0]).toMatchObject({ name: "my-skill", auditStatus: "ok" });
  });

  it("rejects trees that contain nothing installable", async () => {
    const { app } = await seed();
    const service = serviceFor(app, settings());
    await expect(service.installFromTree(new Map([["readme.txt", ENCODER.encode("hi")]]), "x")).rejects.toThrow(/No agent plugin package/);
  });
});

describe("PluginService.installFromSource", () => {
  it("downloads a tarball through the injected fetcher and installs it", async () => {
    const { app, vault } = await seed();
    const current = settings();
    const service = serviceFor(app, current);
    const tarball = (await import("../src/vendor/fflate")).gzipSync(
      makeTar({ "demo/plugin.json": JSON.stringify({ name: "demo", version: "1.0.0" }), "demo/skills/demo/SKILL.md": "# d" }),
    );
    const fetcher = {
      fetchBytes: async (url: string) => {
        expect(url).toBe("https://codeload.github.com/owner/repo/tar.gz/HEAD");
        return { status: 200, bytes: tarball as Uint8Array, contentType: "application/gzip" };
      },
    };
    const result = await service.installFromSource("owner/repo", fetcher);
    expect(result.name).toBe("demo");
    expect(vault.contentOf(".agentic-plugins/demo/plugin.json")).toContain(AGENT_PLUGINS_SCHEMA_ID);
  });

  it("keeps the native manifest verbatim for root-level packages and persists provenance without MCP", async () => {
    const { app, vault } = await seed();
    const current = settings();
    const service = serviceFor(app, current);
    const manifest = {
      $schema: AGENT_PLUGINS_SCHEMA_ID,
      name: "rootly",
      version: "1.2.3",
      description: "Native root-level package",
    };
    const tarball = gzipSync(makeTar({
      "rootly/plugin.json": JSON.stringify(manifest),
      "rootly/skills/rootly/SKILL.md": "---\nname: rootly\ndescription: R\n---\n# Rootly",
      "rootly/README.md": "# Rootly",
    }));
    const fetcher = {
      fetchBytes: async (url: string) => {
        expect(url).toBe("https://codeload.github.com/owner/repo/tar.gz/HEAD");
        return { status: 200, bytes: tarball, contentType: "application/gzip" };
      },
    };
    const result = await service.installFromSource("owner/repo", fetcher);
    expect(result.name).toBe("rootly");
    expect(JSON.parse(vault.contentOf(".agentic-plugins/rootly/plugin.json") as string)).toEqual(manifest);
    expect(current.plugins.sources["rootly"]).toBe("github:owner/repo");
    expect(current.mcp.servers).toHaveLength(0);
  });

  it("rejects HTTP failures instead of installing error pages", async () => {
    const { app } = await seed();
    const service = serviceFor(app, settings());
    const fetcher = {
      fetchBytes: async () =>
        ({ status: 404, bytes: ENCODER.encode("<html>Not Found</html>"), contentType: "text/html" }),
    };
    await expect(service.installFromSource("https://github.com/owner/repo/blob/main/skills/x/SKILL.md", fetcher))
      .rejects.toThrow(/HTTP 404/);
    const fetcher404 = {
      fetchBytes: async () =>
        ({ status: 404, bytes: ENCODER.encode("<html>Not Found</html>"), contentType: "text/html" }),
    };
    await expect(service.installFromSource("https://github.com/owner/repo", fetcher404)).rejects.toThrow(/HTTP 404/);
  });

  it("fetches a single raw SKILL.md for blob-style URLs", async () => {
    const { app } = await seed();
    const service = serviceFor(app, settings());
    const fetcher = {
      fetchBytes: async (url: string) => {
        expect(url).toBe("https://raw.githubusercontent.com/owner/repo/main/skills/x/SKILL.md");
        return { status: 200, bytes: ENCODER.encode("---\nname: x\ndescription: X\n---\n# X"), contentType: "text/plain" };
      },
    };
    const result = await service.installFromSource("https://github.com/owner/repo/blob/main/skills/x/SKILL.md", fetcher);
    expect(result.skills).toBe(1);
    const plugins = await service.reload();
    expect(plugins[0]?.skills.map((s) => s.name)).toEqual(["x"]);
  });
});

describe("PluginService builtins materialization", () => {
  it("writes the builtins package once and never overwrites edits", async () => {
    const { app, vault } = await seed();
    const service = serviceFor(app, settings());
    expect(await service.ensureBuiltinsMaterialized()).toBe(true);
    const path = ".agentic-plugins/builtins/skills/self-knowledge/SKILL.md";
    const first = vault.contentOf(path);
    expect(first).toContain("Self-knowledge");

    await app.vault.modify(app.vault.getAbstractFileByPath(path) as never, "---\nname: self-knowledge\n---\nEDITED");
    expect(await service.ensureBuiltinsMaterialized()).toBe(false);
    expect(vault.contentOf(path)).toContain("EDITED");
  });

  it("repair recreates the package from scratch", async () => {
    const { app, vault } = await seed();
    const service = serviceFor(app, settings());
    await service.ensureBuiltinsMaterialized();
    await service.repairBuiltins();
    const path = ".agentic-plugins/builtins/skills/install-plugin/SKILL.md";
    expect(vault.contentOf(path)).toContain("Install plugin");
  });

  it("materialized builtins load as a normal plugin", async () => {
    const { app } = await seed();
    const service = serviceFor(app, settings());
    await service.ensureBuiltinsMaterialized();
    const plugins = await service.reload();
    expect(plugins.map((p) => p.name)).toContain("builtins");
  });
});

describe("PluginService.removePackage", () => {
  it("removes the folder, its MCP records, and its settings entries", async () => {
    const { app } = await seed();
    const current = settings();
    const service = serviceFor(app, current);
    await service.installFromTree(claudePluginTree(), "github:example/docs-helper");
    expect(app.vault.getAbstractFileByPath(".agentic-plugins/docs-helper/plugin.json")).not.toBeNull();

    await service.removePackage("docs-helper", ".agentic-plugins/docs-helper");
    expect(app.vault.getAbstractFileByPath(".agentic-plugins/docs-helper")).toBeNull();
    expect(current.mcp.servers.filter((s) => s.source === "plugin")).toHaveLength(0);
    expect(current.plugins.sources["docs-helper"]).toBeUndefined();
  });

  it("removes by rootPath, so a renamed folder is removed instead of a guessed path", async () => {
    const { app } = await seed();
    const current = settings();
    const service = serviceFor(app, current);
    await service.installFromTree(claudePluginTree(), "github:example/docs-helper");
    // Simulate the folder having been renamed on disk after install.
    await app.vault.adapter.rename(".agentic-plugins/docs-helper", ".agentic-plugins/docs-helper-renamed");

    await service.removePackage("docs-helper", ".agentic-plugins/docs-helper-renamed");
    expect(app.vault.getAbstractFileByPath(".agentic-plugins/docs-helper-renamed")).toBeNull();
    expect(current.plugins.sources["docs-helper"]).toBeUndefined();
  });
});

describe("PluginService.scaffoldSkill", () => {
  it("creates a spec-valid single-skill package", async () => {
    const { app } = await seed();
    const service = serviceFor(app, settings());
    const result = await service.scaffoldSkill({ name: "Release Notes", description: "Writes release notes", body: "# Steps\n" });
    expect(result.name).toBe("release-notes");
    const plugins = await service.reload();
    expect(plugins[0]?.skills.map((s) => s.name)).toEqual(["release-notes"]);
  });

  it("rejects names without any letter or digit", async () => {
    const { app } = await seed();
    const service = serviceFor(app, settings());
    await expect(service.scaffoldSkill({ name: "!!!", description: "", body: "# x\n" }))
      .rejects.toThrow(/letter or digit/);
  });

  it("reports whether a package name is already installed", async () => {
    const { app } = await seed();
    const service = serviceFor(app, settings());
    expect(await service.packageExists("release-notes")).toBe(false);
    await service.scaffoldSkill({ name: "Release Notes", description: "", body: "# x\n" });
    expect(await service.packageExists("release-notes")).toBe(true);
  });
});

/** Minimal tar archive (ustar, no gzip) for the fetcher fixture. */
function makeTar(files: Record<string, string>): Uint8Array {
  const blocks: number[][] = [];
  for (const [name, content] of Object.entries(files)) {
    const body = new TextEncoder().encode(content);
    const header = new Uint8Array(512);
    for (let i = 0; i < name.length; i += 1) header[i] = name.charCodeAt(i);
    const size = body.length.toString(8).padStart(11, "0") + "\0";
    for (let i = 0; i < size.length; i += 1) header[124 + i] = size.charCodeAt(i);
    header[156] = 0x30;
    blocks.push([...header]);
    const padded = new Uint8Array(Math.ceil(body.length / 512) * 512);
    padded.set(body);
    blocks.push([...padded]);
  }
  blocks.push(new Array(512).fill(0), new Array(512).fill(0));
  return new Uint8Array(blocks.flat());
}