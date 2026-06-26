import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import { TFile, TFolder } from "obsidian";
import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  type AgentProfile,
  BUILTIN_AGENT_PROFILES,
  formatSubagentsForSystemPrompt,
  loadAgentProfiles,
} from "../src/agent/subagents";
import {
  createSubagentTool,
  normalizeTasks,
  type SubagentDetails,
} from "../src/tools/subagent-tool";
import { buildModel } from "../src/llm/models";
import { filterChildTools } from "../src/agent/subagent-runtime";
import { createVaultTools } from "../src/tools/vault-tools";

const TEST_MODEL: Model<"openai-completions"> = buildModel({
  provider: "openrouter",
  modelId: "test/model",
  privacy: { denyDataCollection: true, requireZDR: true, allowFallbacks: true },
  ollamaBaseUrl: "http://localhost:11434",
  openaiCompatibleBaseUrl: "http://localhost:3000/api",
});

/** A child stream that returns a fixed assistant reply with usage, no network. */
function childStreamFn(text: string): StreamFn {
  return ((model: Model<"openai-completions">) => {
    const stream = createAssistantMessageEventStream();
    const message = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 7, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop" as const,
      timestamp: Date.now(),
    };
    queueMicrotask(() => {
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
    });
    return stream;
  }) as unknown as StreamFn;
}

/** A child stream that never completes until its run signal aborts. */
function hangingStreamFn(): StreamFn {
  return ((model: Model<"openai-completions">, _context: unknown, options?: { signal?: AbortSignal }) => {
    const stream = createAssistantMessageEventStream();
    const finish = (): void => {
      const message = {
        role: "assistant" as const,
        content: [] as { type: "text"; text: string }[],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop" as const,
        timestamp: Date.now(),
      };
      stream.push({ type: "start", partial: { ...message } });
      stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
    };
    const signal = options?.signal;
    if (signal?.aborted) finish();
    else signal?.addEventListener("abort", finish);
    return stream;
  }) as unknown as StreamFn;
}

function makeChild(streamFn: StreamFn): Agent {
  return new Agent({
    streamFn,
    initialState: { systemPrompt: "child", model: TEST_MODEL, thinkingLevel: "off", tools: [], messages: [] },
  });
}

const RESEARCHER: AgentProfile = {
  name: "researcher",
  description: "test researcher",
  systemPrompt: "research",
  toolAllowlist: [],
};

function firstText(content: { type: string }[]): string {
  const block = content[0] as { type: string; text?: string };
  return block.text ?? "";
}

/** Build a fake App whose vault holds the given Markdown files under `folder`. */
function makeVaultApp(folder: string, files: Array<{ path: string; content: string }>): App {
  const folderObj = new TFolder();
  folderObj.path = folder;
  folderObj.name = folder.split("/").pop() ?? folder;
  const entries = files.map(({ path, content }) => {
    const file = new TFile();
    file.path = path;
    file.name = path.split("/").pop() ?? path;
    file.basename = file.name.replace(/\.md$/i, "");
    file.parent = folderObj;
    return { file, content };
  });
  return {
    vault: {
      getMarkdownFiles: () => entries.map((entry) => entry.file),
      cachedRead: async (file: TFile) => entries.find((entry) => entry.file === file)?.content ?? "",
    },
  } as unknown as App;
}

describe("loadAgentProfiles", () => {
  it("offers the built-in roster when no vault folder is set", async () => {
    const app = { vault: {} } as unknown as App;
    const profiles = await loadAgentProfiles(app, "", true);
    expect(profiles.map((p) => p.name).sort()).toEqual(["editor", "researcher", "reviewer"]);
    expect(profiles).toHaveLength(BUILTIN_AGENT_PROFILES.length);
  });

  it("returns nothing when built-ins are disabled and no folder is set", async () => {
    const app = { vault: {} } as unknown as App;
    expect(await loadAgentProfiles(app, "", false)).toEqual([]);
  });

  it("lets a vault AGENT.md override a built-in of the same name", async () => {
    const app = makeVaultApp("Agents", [
      { path: "Agents/researcher.md", content: "---\nname: researcher\ndescription: Custom recon\n---\nCustom prompt body" },
    ]);
    const profiles = await loadAgentProfiles(app, "Agents", true);
    const researcher = profiles.find((p) => p.name === "researcher");
    expect(researcher?.systemPrompt).toBe("Custom prompt body");
    expect(researcher?.description).toBe("Custom recon");
    // The other built-ins remain.
    expect(profiles.map((p) => p.name).sort()).toEqual(["editor", "researcher", "reviewer"]);
  });

  it("parses a comma-separated tools allowlist from frontmatter", async () => {
    const app = makeVaultApp("Agents", [
      { path: "Agents/scribe.md", content: "---\nname: scribe\ntools: read, grep, write\n---\nDo the thing." },
    ]);
    const profiles = await loadAgentProfiles(app, "Agents", false);
    expect(profiles).toHaveLength(1);
    expect(profiles[0].toolAllowlist).toEqual(["read", "grep", "write"]);
  });
});

describe("formatSubagentsForSystemPrompt", () => {
  it("lists each profile, or is empty when there are none", () => {
    expect(formatSubagentsForSystemPrompt([])).toBe("");
    const block = formatSubagentsForSystemPrompt(BUILTIN_AGENT_PROFILES);
    expect(block).toContain("## Subagents");
    expect(block).toContain("researcher");
    expect(block).toContain("editor");
  });
});

describe("normalizeTasks", () => {
  it("accepts the parallel and single shapes and rejects empties", () => {
    expect(normalizeTasks({ tasks: [{ agent: "a", task: "t" }] })).toEqual([{ agent: "a", task: "t" }]);
    expect(normalizeTasks({ agent: "a", task: "t" })).toEqual([{ agent: "a", task: "t" }]);
    expect(normalizeTasks({})).toEqual([]);
    expect(normalizeTasks({ tasks: [] })).toEqual([]);
    expect(normalizeTasks({ agent: "a" })).toEqual([]);
  });

  it("guards against malformed model output", () => {
    // tasks emitted as a non-array, or items missing agent/task, must not throw.
    expect(normalizeTasks({ tasks: "nope" } as unknown as { tasks?: never })).toEqual([]);
    expect(
      normalizeTasks({ tasks: [{ agent: "a" }, { agent: "b", task: "t" }] } as unknown as {
        tasks?: { agent: string; task: string }[];
      }),
    ).toEqual([{ agent: "b", task: "t" }]);
    // Blank / whitespace-only agent or task is rejected (trimmed then filtered).
    expect(normalizeTasks({ agent: "researcher", task: "  " })).toEqual([]);
    expect(normalizeTasks({ tasks: [{ agent: " ", task: "t" }] })).toEqual([]);
  });
});

describe("filterChildTools", () => {
  const tools = createVaultTools({ vault: {}, workspace: {} } as unknown as App);
  const names = (subset: ReturnType<typeof createVaultTools>): string[] => subset.map((tool) => tool.name).sort();

  it("restricts to the named allowlist", () => {
    expect(names(filterChildTools(tools, ["read", "search"], false))).toEqual(["read", "search"]);
  });

  it("defaults an empty allowlist to the read-only tools", () => {
    const result = names(filterChildTools(tools, [], false));
    expect(result).toContain("read");
    expect(result).not.toContain("write");
    expect(result).not.toContain("delete");
  });

  it("strips mutating tools in read-only mode even when allowlisted", () => {
    expect(names(filterChildTools(tools, ["read", "write", "delete"], true))).toEqual(["read"]);
  });
});

describe("createSubagentTool", () => {
  it("dispatches a single child and returns its summary", async () => {
    const usages: { totalTokens: number }[] = [];
    const updates: SubagentDetails[] = [];
    const tool = createSubagentTool({
      getProfiles: () => [RESEARCHER],
      createChildAgent: () => makeChild(childStreamFn("child result")),
      recordUsage: (usage) => usages.push(usage),
    });
    const result = await tool.execute(
      "id",
      { agent: "researcher", task: "find X" },
      undefined,
      (partial) => updates.push(partial.details),
    );
    expect(firstText(result.content)).toBe("child result");
    expect(result.details.children[0]).toMatchObject({ agent: "researcher", status: "done", summary: "child result" });
    expect(usages).toHaveLength(1);
    expect(usages[0].totalTokens).toBe(7);
    // Streamed at least an initial "running" snapshot and a final "done" snapshot.
    expect(updates.length).toBeGreaterThanOrEqual(2);
    expect(updates[0].children[0].status).toBe("running");
  });

  it("runs several children in parallel and merges their summaries", async () => {
    const usages: { totalTokens: number }[] = [];
    const tool = createSubagentTool({
      getProfiles: () => [RESEARCHER],
      createChildAgent: () => makeChild(childStreamFn("ok")),
      recordUsage: (usage) => usages.push(usage),
    });
    const result = await tool.execute(
      "id",
      { tasks: [{ agent: "researcher", task: "A" }, { agent: "researcher", task: "B" }] },
      undefined,
    );
    const text = firstText(result.content);
    expect(text).toContain("### researcher: A");
    expect(text).toContain("### researcher: B");
    expect(result.details.children).toHaveLength(2);
    expect(result.details.children.every((child) => child.status === "done")).toBe(true);
    expect(usages).toHaveLength(2);
  });

  it("throws on an unknown agent and on an empty request", async () => {
    const tool = createSubagentTool({
      getProfiles: () => [RESEARCHER],
      createChildAgent: () => makeChild(childStreamFn("x")),
    });
    await expect(tool.execute("id", { agent: "ghost", task: "x" }, undefined)).rejects.toThrow(/unknown agent/i);
    await expect(tool.execute("id", {}, undefined)).rejects.toThrow(/provide either/i);
  });

  it("rejects a fan-out beyond the hard task cap", async () => {
    const tool = createSubagentTool({
      getProfiles: () => [RESEARCHER],
      createChildAgent: () => makeChild(childStreamFn("x")),
    });
    const tasks = Array.from({ length: 21 }, (_, i) => ({ agent: "researcher", task: `t${i}` }));
    await expect(tool.execute("id", { tasks }, undefined)).rejects.toThrow(/too many tasks/i);
  });

  it("truncates an oversized child summary before it reaches the parent", async () => {
    const tool = createSubagentTool({
      getProfiles: () => [RESEARCHER],
      createChildAgent: () => makeChild(childStreamFn("x".repeat(20_000))),
    });
    const result = await tool.execute("id", { agent: "researcher", task: "t" }, undefined);
    const summary = result.details.children[0].summary ?? "";
    expect(summary.length).toBeLessThan(8_200);
    expect(summary).toContain("[Output truncated");
  });

  it("aborts in-flight children when the dispatch signal aborts", async () => {
    const controller = new AbortController();
    const tool = createSubagentTool({
      getProfiles: () => [RESEARCHER],
      createChildAgent: () => makeChild(hangingStreamFn()),
    });
    let settled = false;
    const pending = tool
      .execute("id", { agent: "researcher", task: "hang" }, controller.signal)
      .then((result) => {
        settled = true;
        return result;
      });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(settled).toBe(false);
    controller.abort();
    const result = await pending;
    expect(result.details.children[0].status).not.toBe("running");
  });
});
