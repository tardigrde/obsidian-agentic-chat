import { describe, expect, it } from "vitest";
import {
  AGENT_PLUGINS_MCP_SCHEMA_ID,
  AGENT_PLUGINS_SCHEMA_ID,
  isSingleExecutableToken,
  slugifyPluginName,
  validCwdForm,
  validateMcpConfig,
  validateMcpUrl,
  validatePluginManifest,
  validatePluginName,
} from "../src/plugins/manifest";
import { isLoopbackHost } from "../src/utils/host-policy";

const MINIMAL_MANIFEST = JSON.stringify({
  $schema: AGENT_PLUGINS_SCHEMA_ID,
  name: "my-plugin",
});

function mcpDoc(servers: Record<string, unknown>): string {
  return JSON.stringify({ $schema: AGENT_PLUGINS_MCP_SCHEMA_ID, mcpServers: servers });
}

describe("validatePluginManifest", () => {
  it("accepts a minimal manifest", () => {
    const result = validatePluginManifest(MINIMAL_MANIFEST);
    expect(result.fatal).toBeNull();
    expect(result.manifest?.name).toBe("my-plugin");
  });

  it("accepts the full manifest shape", () => {
    const result = validatePluginManifest(
      JSON.stringify({
        $schema: AGENT_PLUGINS_SCHEMA_ID,
        name: "acme.tools",
        version: "1.2.0",
        description: "Tools",
        author: { name: "A", email: "a@b.c", url: "https://x" },
        homepage: "https://x",
        repository: "https://y",
        license: "MIT",
        keywords: ["a", "b"],
        extensions: { "com.example.client": { setting: true } },
      }),
    );
    expect(result.fatal).toBeNull();
    expect(result.manifest?.extensions?.["com.example.client"]).toEqual({ setting: true });
  });

  it("rejects non-JSON content", () => {
    const result = validatePluginManifest("not json {");
    expect(result.fatal).toMatch(/not valid JSON/);
    expect(result.manifest).toBeNull();
  });

  it("rejects a non-object manifest", () => {
    expect(validatePluginManifest('["a"]').fatal).toMatch(/not valid JSON/);
  });

  it("rejects missing $schema", () => {
    const result = validatePluginManifest(JSON.stringify({ name: "x" }));
    expect(result.fatal).toMatch(/\$schema/);
  });

  it("rejects an unsupported $schema version", () => {
    const result = validatePluginManifest(
      JSON.stringify({ $schema: "https://agent-plugins.org/schemas/0.9.0/plugin.schema.json", name: "x" }),
    );
    expect(result.fatal).toMatch(/unsupported Agent Plugins schema/);
  });

  it("rejects missing or invalid name", () => {
    expect(validatePluginManifest(JSON.stringify({ $schema: AGENT_PLUGINS_SCHEMA_ID })).fatal).toMatch(/name/);
    expect(
      validatePluginManifest(JSON.stringify({ $schema: AGENT_PLUGINS_SCHEMA_ID, name: "My-Plugin" })).fatal,
    ).toMatch(/name/);
  });

  it("rejects wrong-typed known fields as fatal", () => {
    const result = validatePluginManifest(
      JSON.stringify({ $schema: AGENT_PLUGINS_SCHEMA_ID, name: "x", version: 42 }),
    );
    expect(result.fatal).toMatch(/version/);
  });

  it("reports and ignores unknown top-level fields", () => {
    const result = validatePluginManifest(
      JSON.stringify({ $schema: AGENT_PLUGINS_SCHEMA_ID, name: "x", surprise: true }),
    );
    expect(result.fatal).toBeNull();
    expect(result.reports.some((report) => report.message.includes("Unknown top-level field"))).toBe(true);
  });

  it("reports and ignores a non-object extensions field", () => {
    const result = validatePluginManifest(
      JSON.stringify({ $schema: AGENT_PLUGINS_SCHEMA_ID, name: "x", extensions: "nope" }),
    );
    expect(result.fatal).toBeNull();
    const extensionReports = result.reports.filter((report) => report.message.includes("extensions"));
    expect(extensionReports).toHaveLength(1);
  });

  it("rejects an author object with extra fields", () => {
    const result = validatePluginManifest(
      JSON.stringify({ $schema: AGENT_PLUGINS_SCHEMA_ID, name: "x", author: { name: "A", extra: "b" } }),
    );
    expect(result.fatal).toMatch(/author/);
  });

  it("does not reject merely-invalid metadata values (semver/URL/email)", () => {
    const result = validatePluginManifest(
      JSON.stringify({
        $schema: AGENT_PLUGINS_SCHEMA_ID,
        name: "x",
        version: "not-semver",
        homepage: "not-a-url",
        license: "not-spdx",
      }),
    );
    expect(result.fatal).toBeNull();
  });
});

describe("validatePluginName", () => {
  it.each([
    ["my-plugin", true],
    ["acme.tools", true],
    ["lint3r", true],
    ["a", true],
    ["My-Plugin", false],
    ["-start", false],
    ["has--double", false],
    ["too.many..dots", false],
    ["", false],
    ["a".repeat(65), false],
  ])("validates %s -> %s", (name, expected) => {
    expect(validatePluginName(name)).toBe(expected);
  });
});

describe("slugifyPluginName", () => {
  it("slugifies a user server name into a valid plugin name", () => {
    expect(validatePluginName(slugifyPluginName("Internal Tools MCP"))).toBe(true);
    expect(slugifyPluginName("Internal Tools MCP")).toBe("internal-tools-mcp");
  });

  it("falls back to a safe default when nothing survives", () => {
    expect(slugifyPluginName("!!!")).toBe("plugin");
  });
});

describe("validateMcpConfig", () => {
  it("accepts a valid streamable-http server", () => {
    const result = validateMcpConfig(
      mcpDoc({ "deployment-api": { type: "streamable-http", url: "https://deploy.example.com/mcp" } }),
      AGENT_PLUGINS_MCP_SCHEMA_ID,
    );
    expect(result.ok).toBe(true);
    expect(result.servers[0]?.transport).toBe("streamable-http");
    expect(result.servers[0]?.problems).toEqual([]);
  });

  it("accepts headers and validates them", () => {
    const result = validateMcpConfig(
      mcpDoc({ s: { type: "streamable-http", url: "https://x.example/mcp", headers: { "X-Tenant": "public" } } }),
      AGENT_PLUGINS_MCP_SCHEMA_ID,
    );
    expect(result.ok).toBe(true);
    expect(result.servers[0]?.headers).toEqual({ "X-Tenant": "public" });
  });

  it("flags duplicate header names under different casing", () => {
    const result = validateMcpConfig(
      mcpDoc({ s: { type: "streamable-http", url: "https://x.example/mcp", headers: { "X-T": "a", "x-t": "b" } } }),
      AGENT_PLUGINS_MCP_SCHEMA_ID,
    );
    expect(result.servers[0]?.problems.join(" ")).toMatch(/repeated under different casing/);
  });

  it("rejects a client-managed authorization header", () => {
    const result = validateMcpConfig(
      mcpDoc({ s: { type: "streamable-http", url: "https://x.example/mcp", headers: { Authorization: "Bearer x" } } }),
      AGENT_PLUGINS_MCP_SCHEMA_ID,
    );
    expect(result.servers[0]?.problems.join(" ")).toMatch(/authorization.*managed by the client/);
  });

  it("rejects framing headers but allows cookie and warns on soft-managed protocol headers", () => {
    const framing = validateMcpConfig(
      mcpDoc({ s: { type: "streamable-http", url: "https://x.example/mcp", headers: { "Transfer-Encoding": "chunked" } } }),
      AGENT_PLUGINS_MCP_SCHEMA_ID,
    );
    expect(framing.servers[0]?.problems.join(" ")).toMatch(/transfer-encoding.*managed by the client/);

    const cookieOk = validateMcpConfig(
      mcpDoc({ s: { type: "streamable-http", url: "https://x.example/mcp", headers: { Cookie: "session=abc" } } }),
      AGENT_PLUGINS_MCP_SCHEMA_ID,
    );
    expect(cookieOk.servers[0]?.problems).toEqual([]);

    const soft = validateMcpConfig(
      mcpDoc({ s: { type: "streamable-http", url: "https://x.example/mcp", headers: { "Content-Type": "text/xml" } } }),
      AGENT_PLUGINS_MCP_SCHEMA_ID,
    );
    expect(soft.servers[0]?.problems).toEqual([]);
    expect(soft.reports.some((report) => report.severity === "warning" && report.message.includes("content-type"))).toBe(true);
  });

  it("rejects a mismatched $schema version", () => {
    const result = validateMcpConfig(mcpDoc({}), "https://agent-plugins.org/schemas/0.9.0/mcp.schema.json");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/does not match/);
  });

  it("rejects unknown top-level fields", () => {
    const result = validateMcpConfig(JSON.stringify({ $schema: AGENT_PLUGINS_MCP_SCHEMA_ID, mcpServers: {}, extra: 1 }), AGENT_PLUGINS_MCP_SCHEMA_ID);
    expect(result.ok).toBe(false);
  });

  it("rejects non-object mcpServers", () => {
    const result = validateMcpConfig(JSON.stringify({ $schema: AGENT_PLUGINS_MCP_SCHEMA_ID, mcpServers: [] }), AGENT_PLUGINS_MCP_SCHEMA_ID);
    expect(result.ok).toBe(false);
  });

  it("accepts an empty mcpServers object", () => {
    const result = validateMcpConfig(mcpDoc({}), AGENT_PLUGINS_MCP_SCHEMA_ID);
    expect(result.ok).toBe(true);
    expect(result.servers).toEqual([]);
  });

  it("isolates invalid entries and keeps valid ones", () => {
    const result = validateMcpConfig(
      mcpDoc({
        good: { type: "streamable-http", url: "https://ok.example/mcp" },
        bad: { type: "streamable-http", url: "ftp://nope" },
      }),
      AGENT_PLUGINS_MCP_SCHEMA_ID,
    );
    expect(result.ok).toBe(true);
    expect(result.servers.find((server) => server.key === "good")?.problems).toEqual([]);
    expect(result.servers.find((server) => server.key === "bad")?.problems.length).toBeGreaterThan(0);
  });

  it("skips stdio entries as unsupported, not invalid", () => {
    const result = validateMcpConfig(
      mcpDoc({ local: { type: "stdio", command: "./bin/server", args: ["--data", "${PLUGIN_DATA}/x"], env: { CONFIG: "${PLUGIN_ROOT}/config.json" }, cwd: "${PLUGIN_ROOT}" } }),
      AGENT_PLUGINS_MCP_SCHEMA_ID,
    );
    expect(result.ok).toBe(true);
    expect(result.servers[0]?.problems).toEqual([]);
    expect(result.reports.some((report) => report.message.includes("stdio"))).toBe(true);
  });

  it("flags reserved env variables in stdio entries", () => {
    const result = validateMcpConfig(
      mcpDoc({ local: { type: "stdio", command: "./bin", env: { PLUGIN_ROOT: "/x" } } }),
      AGENT_PLUGINS_MCP_SCHEMA_ID,
    );
    expect(result.servers[0]?.problems.join(" ")).toMatch(/PLUGIN_ROOT/);
  });

  it("flags shell-command stdio entries", () => {
    const result = validateMcpConfig(
      mcpDoc({ local: { type: "stdio", command: "npx -y @foo/bar" } }),
      AGENT_PLUGINS_MCP_SCHEMA_ID,
    );
    expect(result.servers[0]?.problems.join(" ")).toMatch(/single executable token/);
  });

  it("skips sse entries as unsupported", () => {
    const result = validateMcpConfig(
      mcpDoc({ legacy: { type: "sse", url: "https://x.example/sse" } }),
      AGENT_PLUGINS_MCP_SCHEMA_ID,
    );
    expect(result.ok).toBe(true);
    expect(result.reports.some((report) => report.message.includes("sse"))).toBe(true);
  });

  it("rejects an entry with a field from another variant", () => {
    const result = validateMcpConfig(
      mcpDoc({ weird: { type: "streamable-http", url: "https://x.example/mcp", command: "./bin" } }),
      AGENT_PLUGINS_MCP_SCHEMA_ID,
    );
    expect(result.servers[0]?.problems.join(" ")).toMatch(/command/);
  });
});

describe("validateMcpUrl", () => {
  it("accepts https URLs", () => {
    expect(validateMcpUrl("https://mcp.example.com/mcp")).toBeNull();
  });

  it("accepts http only for loopback hosts", () => {
    expect(validateMcpUrl("http://localhost:3000/mcp")).toBeNull();
    expect(validateMcpUrl("http://127.0.0.1:8080/mcp")).toBeNull();
    expect(validateMcpUrl("http://[::1]:3000/mcp")).toBeNull();
    expect(validateMcpUrl("http://mcp.example.com/mcp")).toMatch(/https/);
  });

  it("rejects user info, fragments, and non-http schemes", () => {
    expect(validateMcpUrl("https://user:pass@x.example/mcp")).toMatch(/user information/);
    expect(validateMcpUrl("https://x.example/mcp#frag")).toMatch(/fragment/);
    expect(validateMcpUrl("ftp://x.example/mcp")).toMatch(/http/);
    expect(validateMcpUrl("not a url")).toMatch(/valid absolute URL/);
  });

  it("rejects https to cloud-metadata and link-local hosts", () => {
    expect(validateMcpUrl("https://169.254.169.254/mcp")).toMatch(/link-local|cloud-metadata|non-routable/);
    expect(validateMcpUrl("https://[fe80::1]:443/mcp")).toMatch(/link-local|cloud-metadata|non-routable/);
    expect(validateMcpUrl("https://0.0.0.0/mcp")).toMatch(/link-local|cloud-metadata|non-routable/);
  });

  it("still allows https to loopback and private LAN hosts (IPv4 + IPv6 ULA)", () => {
    expect(validateMcpUrl("https://localhost:8443/mcp")).toBeNull();
    expect(validateMcpUrl("https://127.0.0.1:8443/mcp")).toBeNull();
    expect(validateMcpUrl("https://10.0.0.5/mcp")).toBeNull();
    expect(validateMcpUrl("https://192.168.1.10/mcp")).toBeNull();
    expect(validateMcpUrl("https://[fd00::1]:8443/mcp")).toBeNull();
  });
});

describe("transport helpers", () => {
  it("isSingleExecutableToken", () => {
    expect(isSingleExecutableToken("./bin/server")).toBe(true);
    expect(isSingleExecutableToken("npx")).toBe(true);
    expect(isSingleExecutableToken("npx -y pkg")).toBe(false);
  });

  it("validCwdForm", () => {
    expect(validCwdForm("./data")).toBe(true);
    expect(validCwdForm("${PLUGIN_ROOT}")).toBe(true);
    expect(validCwdForm("${PLUGIN_DATA}/db")).toBe(true);
    expect(validCwdForm("data")).toBe(false);
    expect(validCwdForm("../escape")).toBe(false);
  });

  it("isLoopbackHost", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.255.1.2")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("mcp.example.com")).toBe(false);
  });
});
