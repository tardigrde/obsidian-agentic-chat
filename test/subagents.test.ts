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
  abortSubagentChild,
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

/** A child stream that emits text_delta chunks so the live transcript is populated. */
function streamingChildStreamFn(text: string): StreamFn {
  return ((model: Model<"openai-completions">) => {
    const stream = createAssistantMessageEventStream();
    const message = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: { input: 3, output: text.length, cacheRead: 0, cacheWrite: 0, totalTokens: 3 + text.length, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop" as const,
      timestamp: Date.now(),
    };
    queueMicrotask(() => {
      stream.push({ type: "start", partial: { ...message, content: [] } });
      for (let i = 0; i < text.length; i += 3) {
        const chunk = text.slice(i, i + 3);
        const partialText = text.slice(0, i + 3);
        stream.push({
          type: "text_delta",
          contentIndex: 0,
          delta: chunk,
          partial: { ...message, content: [{ type: "text", text: partialText }] },
        });
      }
      stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
    });
    return stream;
  }) as unknown as StreamFn;
}

/** A child stream that always fails with an error message, no network. */
function errorStreamFn(message = "boom"): StreamFn {
  return ((model: Model<"openai-completions">) => {
    const stream = createAssistantMessageEventStream();
    const failure = {
      role: "assistant" as const,
      content: [] as { type: "text"; text: string }[],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "error" as const,
      errorMessage: message,
      timestamp: Date.now(),
    };
    queueMicrotask(() => {
      stream.push({ type: "error", reason: "error", error: failure });
      stream.end(failure);
    });
    return stream;
  }) as unknown as StreamFn;
}

/** A child stream that errors when its run signal aborts (real abort semantics). */
function abortErrorStreamFn(message = "Request was aborted"): StreamFn {
  return ((model: Model<"openai-completions">, _context: unknown, options?: { signal?: AbortSignal }) => {
    const stream = createAssistantMessageEventStream();
    const fail = (): void => {
      const failure = {
        role: "assistant" as const,
        content: [] as { type: "text"; text: string }[],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "aborted" as const,
        errorMessage: message,
        timestamp: Date.now(),
      };
      stream.push({ type: "error", reason: "aborted", error: failure });
      stream.end(failure);
    };
    const signal = options?.signal;
    if (signal?.aborted) fail();
    else signal?.addEventListener("abort", fail, { once: true });
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
    expect(profiles.find((profile) => profile.name === "researcher")?.toolAllowlist).toEqual(
      expect.arrayContaining(["web_search", "fetch_url", "read_artifact"]),
    );
    expect(profiles.find((profile) => profile.name === "reviewer")?.toolAllowlist).toEqual(
      expect.arrayContaining(["web_search", "fetch_url", "search_artifact"]),
    );
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
  it("accepts a single task and rejects empties", () => {
    expect(normalizeTasks({ agent: "a", task: "t" })).toEqual([{ agent: "a", task: "t" }]);
    expect(normalizeTasks({})).toEqual([]);
    expect(normalizeTasks({ agent: "a" })).toEqual([]);
    expect(normalizeTasks({ task: "t" })).toEqual([]);
  });

  it("guards against blank agent or task", () => {
    expect(normalizeTasks({ agent: "researcher", task: "  " })).toEqual([]);
    expect(normalizeTasks({ agent: "  ", task: "t" })).toEqual([]);
    expect(normalizeTasks({ agent: "a", task: "t" })).toEqual([{ agent: "a", task: "t" }]);
  });
});

describe("filterChildTools", () => {
  const tools = createVaultTools({ vault: {}, workspace: {} } as unknown as App);
  const names = (subset: ReturnType<typeof createVaultTools>): string[] => subset.map((tool) => tool.name).sort();

  it("restricts to the named allowlist", () => {
    expect(names(filterChildTools(tools, ["read", "vault_inspect"], false))).toEqual(["read", "vault_inspect"]);
  });

  it("defaults an empty allowlist to the read-only tools", () => {
    const result = names(filterChildTools(tools, [], false));
    expect(result).toContain("read");
    expect(result).toContain("vault_inspect");
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

  it("throws on an unknown agent and on an empty request", async () => {
    const tool = createSubagentTool({
      getProfiles: () => [RESEARCHER],
      createChildAgent: () => makeChild(childStreamFn("x")),
    });
    await expect(tool.execute("id", { agent: "ghost", task: "x" }, undefined)).rejects.toThrow(/unknown agent/i);
    await expect(tool.execute("id", { agent: "researcher", task: "" }, undefined)).rejects.toThrow(
      /provide both \{agent, task\}/i,
    );
    await expect(tool.execute("id", { agent: "", task: "x" }, undefined)).rejects.toThrow(
      /provide both \{agent, task\}/i,
    );
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

  it("collects a live transcript and stopId while a child streams", async () => {
    const updates: SubagentDetails[] = [];
    const tool = createSubagentTool({
      getProfiles: () => [RESEARCHER],
      createChildAgent: () => makeChild(streamingChildStreamFn("live result")),
    });
    const result = await tool.execute(
      "call-1",
      { agent: "researcher", task: "stream" },
      undefined,
      (partial) => updates.push(partial.details),
    );
    const child = result.details.children[0];
    expect(child.status).toBe("done");
    expect(child.stopId).toBe("call-1");
    expect(child.transcript?.length).toBeGreaterThan(0);
    const textEntries = child.transcript?.filter((e) => e.type === "text") ?? [];
    expect(textEntries.map((e) => e.text).join("")).toBe("live result");
  });

  it("lets a caller abort one dispatch without stopping its siblings", async () => {
    let created = 0;
    const tool = createSubagentTool({
      getProfiles: () => [RESEARCHER],
      createChildAgent: () => {
        const isFirst = created++ === 0;
        return makeChild(isFirst ? abortErrorStreamFn() : childStreamFn("ok"));
      },
    });
    const controller = new AbortController();
    const first = tool.execute("call-a", { agent: "researcher", task: "A" }, controller.signal);
    const second = tool.execute("call-b", { agent: "researcher", task: "B" }, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 25));

    // Abort just the first dispatch by its stopId (== its tool call id).
    abortSubagentChild("call-a");

    const secondResult = await second;
    expect(secondResult.details.children[0].status).toBe("done");
    // A stopped child surfaces as an aborted tool call (red step), not a green check.
    await expect(first).rejects.toThrow(/was stopped/i);
    controller.abort();
  });

  it("settles a failed child as an error and rejects the dispatch call", async () => {
    const tool = createSubagentTool({
      getProfiles: () => [RESEARCHER],
      createChildAgent: () => makeChild(errorStreamFn("disk full")),
    });
    await expect(tool.execute("call-f", { agent: "researcher", task: "t" }, undefined)).rejects.toThrow(
      /failed.*disk full/i,
    );
  });

  it("marks a parent-stopped child as aborted and rejects the dispatch call", async () => {
    const controller = new AbortController();
    const tool = createSubagentTool({
      getProfiles: () => [RESEARCHER],
      createChildAgent: () => makeChild(abortErrorStreamFn()),
    });
    const pending = tool.execute("call-s", { agent: "researcher", task: "hang" }, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 25));
    controller.abort();
    await expect(pending).rejects.toThrow(/was stopped/i);
  });

  it("auto-aborts a child that runs past the configured timeout", async () => {
    const tool = createSubagentTool({
      getProfiles: () => [RESEARCHER],
      createChildAgent: () => makeChild(abortErrorStreamFn()),
      maxRuntimeSeconds: () => 0.05,
    });
    await expect(tool.execute("call-t", { agent: "researcher", task: "slow" }, undefined)).rejects.toThrow(
      /Timed out after/i,
    );
  });

  it("reports per-child duration and token/cost usage once a child settles", async () => {
    const tool = createSubagentTool({
      getProfiles: () => [RESEARCHER],
      createChildAgent: () => makeChild(childStreamFn("measured")),
    });
    const result = await tool.execute("call-u", { agent: "researcher", task: "t" }, undefined);
    const child = result.details.children[0];
    expect(child.status).toBe("done");
    expect(child.durationMs).toBeGreaterThanOrEqual(0);
    expect(child.usage).toMatchObject({ input: 3, output: 4, totalTokens: 7, costUsd: 0 });
  });

  it("caps concurrent dispatches at 10 and queues the rest, promoting on stop", async () => {
    let created = 0;
    const tool = createSubagentTool({
      getProfiles: () => [RESEARCHER],
      createChildAgent: () => {
        created += 1;
        return makeChild(hangingStreamFn());
      },
    });
    const controller = new AbortController();
    const calls = Array.from({ length: 12 }, (_, i) =>
      tool.execute(`call-${i}`, { agent: "researcher", task: `t${i}` }, controller.signal),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Only the cap's worth of children ever started; the rest are queued.
    expect(created).toBe(10);

    // Stopping one running child frees a slot and promotes a queued dispatch.
    abortSubagentChild("call-0");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(created).toBe(11);

    // Aborting the parent settles the running children and rejects the queued one.
    controller.abort();
    const results = await Promise.all(calls);
    expect(results).toHaveLength(12);
    expect(results.every((result) => result.details.children[0].status !== "running")).toBe(true);
  });
});
