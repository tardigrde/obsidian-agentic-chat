import { describe, expect, it, vi } from "vitest";
import { rerankMemoryMatches } from "../src/memory/jev-rerank";
import type { JevTransport } from "../src/agent/jev-client";
import { createMemoryTools } from "../src/tools/memory-tools";
import { DEFAULT_SETTINGS, mergeSettings } from "../src/settings";
import type { AgenticChatSettings } from "../src/settings";
import type { MemorySearchMatch } from "../src/memory/memory";

function jsonTransport(body: unknown): JevTransport {
  return async () => ({ status: 200, text: JSON.stringify(body) });
}

const KEY = "test-key";
const ON = { enabled: true, apiKey: KEY, allowEgress: true } as const;

function match(id: string, text: string, score: number, scope: "global" | "vault" = "global"): MemorySearchMatch {
  return {
    record: { id, kind: "fact", text, scope },
    score,
    matchedTokens: ["x"],
  } as MemorySearchMatch;
}

describe("rerankMemoryMatches", () => {
  it("identity when disabled, egress-unacknowledged, keyless, or <2 matches", async () => {
    const ms = [match("a", "alpha", 2), match("b", "beta", 1)];
    const t = vi.fn(jsonTransport({ answers: {} }));
    for (const cfg of [
      { ...ON, enabled: false },
      { ...ON, allowEgress: false },
      { ...ON, apiKey: "" },
    ]) {
      const r = await rerankMemoryMatches("q", ms, { ...cfg, transport: t });
      expect(r.source).toBe("heuristic");
      expect(r.matches.map((m) => m.record.id)).toEqual(["a", "b"]);
    }
    expect(t).not.toHaveBeenCalled();
    const single = await rerankMemoryMatches("q", [ms[0]!], { ...ON, transport: t });
    expect(single.source).toBe("heuristic");
  });

  it("reorders by jev probabilities", async () => {
    const ms = [match("a", "alpha", 5), match("b", "beta", 4), match("c", "gamma", 3)];
    const t = jsonTransport({
      answers: {
        best: {
          type: "choice",
          choice: "m2",
          probabilities: { m0: 0.1, m1: 0.2, m2: 0.7 },
          confidence: 0.6,
        },
      },
    });
    const r = await rerankMemoryMatches("which gamma?", ms, { ...ON, transport: t });
    expect(r.source).toBe("jev");
    expect(r.matches.map((m) => m.record.id)).toEqual(["c", "b", "a"]);
  });

  it("fail-open on error, malformed, and non-finite probs", async () => {
    const ms = [match("a", "alpha", 2), match("b", "beta", 1)];
    const err = (async () => { throw new Error("net"); }) as unknown as JevTransport;
    expect((await rerankMemoryMatches("q", ms, { ...ON, transport: err })).source).toBe("heuristic");
    const bad = jsonTransport({ answers: { best: { type: "choice", choice: "m0", probabilities: { m0: NaN, m1: 1 }, confidence: 1 } } });
    expect((await rerankMemoryMatches("q", ms, { ...ON, transport: bad })).source).toBe("heuristic");
    const non2xx = (async () => ({ status: 500, text: "no" })) as unknown as JevTransport;
    expect((await rerankMemoryMatches("q", ms, { ...ON, transport: non2xx })).source).toBe("heuristic");
    const missing = jsonTransport({ answers: {} });
    expect((await rerankMemoryMatches("q", ms, { ...ON, transport: missing })).source).toBe("heuristic");
  });

  it("pins vault-scoped memories unless included", async () => {
    const ms = [match("g1", "global one", 1), match("v1", "vault one", 5, "vault"), match("g2", "global two", 0.5)];
    const t = jsonTransport({
      answers: { best: { type: "choice", choice: "m1", probabilities: { m0: 0.1, m1: 0.9 }, confidence: 0.9 } },
    });
    const r = await rerankMemoryMatches("q", ms, { ...ON, transport: t });
    expect(r.source).toBe("jev");
    // Vault stays last in lexical order even though it scored highest.
    expect(r.matches.map((m) => m.record.id)).toEqual(["g2", "g1", "v1"]);
    // Included => all three reranked together.
    const t2 = jsonTransport({
      answers: { best: { type: "choice", choice: "m0", probabilities: { m0: 0.8, m1: 0.1, m2: 0.1 }, confidence: 0.9 } },
    });
    const r2 = await rerankMemoryMatches("q", ms, { ...ON, includeVaultScope: true, transport: t2 });
    expect(r2.matches[0]?.record.id).toBe("g1");
  });

  it("redacts secrets before egress", async () => {
    let seen = "";
    const capture: JevTransport = async (req) => {
      seen = req.body;
      return { status: 200, text: JSON.stringify({ answers: {} }) };
    };
    await rerankMemoryMatches("q", [match("a", "deploy token sk-abcdefgh12345678 end", 2, "global"), match("b", "plain note", 1, "global")], {
      ...ON,
      transport: capture,
    });
    expect(seen).not.toContain("sk-abcdefgh12345678");
    expect(seen).toContain("plain note");
  });

  it("memoizes identical rerank inputs", async () => {
    const ms = [match("a", "alpha", 2), match("b", "beta", 1)];
    const t = vi.fn(
      jsonTransport({
        answers: { best: { type: "choice", choice: "m1", probabilities: { m0: 0.2, m1: 0.8 }, confidence: 0.7 } },
      }),
    );
    const r1 = await rerankMemoryMatches("memo-q diluted", ms, { ...ON, transport: t });
    const r2 = await rerankMemoryMatches("memo-q diluted", ms, { ...ON, transport: t });
    expect(r1.source).toBe("jev");
    expect(r2.source).toBe("jev");
    expect(t).toHaveBeenCalledTimes(1);
    expect(r2.matches.map((m) => m.record.id)).toEqual(["b", "a"]);
  });

  it("preserves tail beyond top-8 in lexical order", async () => {
    const ms = Array.from({ length: 10 }, (_, i) => match(`m${i}`, `note ${i}`, 10 - i));
    const probs: Record<string, number> = {};
    for (let i = 0; i < 8; i++) probs[`m${i}`] = 8 - i;
    const t = jsonTransport({ answers: { best: { type: "choice", choice: "m0", probabilities: probs, confidence: 0.9 } } });
    const r = await rerankMemoryMatches("q", ms, { ...ON, transport: t });
    expect(r.source).toBe("jev");
    expect(r.matches.slice(8).map((m) => m.record.id)).toEqual(["m8", "m9"]);
  });
});

describe("jev settings healing", () => {
  it("defaults to disabled + no egress", () => {
    const s = mergeSettings({});
    expect(s.jev.rerank).toMatchObject({ enabled: false, allowEgress: false });
  });
  it("heals hostile values", () => {
    const s = mergeSettings({
      jev: { rerank: { enabled: 1, allowEgress: "yes", timeoutMs: -5 } },
    } as unknown as Partial<AgenticChatSettings>);
    expect(s.jev.rerank.enabled).toBe(false);
    expect(s.jev.rerank.allowEgress).toBe(false);
    expect(s.jev.rerank.timeoutMs).toBeGreaterThanOrEqual(50);
  });
});

describe("search_memory jev wiring", () => {
  const jsonl = [
    JSON.stringify({ id: "m1", kind: "fact", text: "vault project uses bun", scope: "global" }),
    JSON.stringify({ id: "m2", kind: "fact", text: "favorite color blue", scope: "global" }),
    JSON.stringify({ id: "m3", kind: "preference", text: "bun test runner preferred", scope: "global" }),
  ].join("\n");
  const adapter = {
    exists: async () => true,
    read: async () => jsonl,
  };

  function settingsWith(rerank: Partial<{ enabled: boolean; allowEgress: boolean }>): AgenticChatSettings {
    return {
      ...DEFAULT_SETTINGS,
      jev: {
        ...DEFAULT_SETTINGS.jev,
        apiKey: KEY,
        rerank: { ...DEFAULT_SETTINGS.jev.rerank, enabled: rerank.enabled ?? false, allowEgress: rerank.allowEgress ?? false },
      },
    };
  }

  it("keeps lexical order when disabled (no transport call)", async () => {
    const transport = vi.fn(jsonTransport({ answers: {} }));
    const [tool] = createMemoryTools({} as never, {
      adapter: adapter as never,
      memoryPath: "mem.jsonl",
      jev: { settings: settingsWith({}), transport },
    });
    const res = (await tool.execute("e1", { query: "bun" }, {} as never)) as { details: { jevReranked: boolean } };
    expect(transport).not.toHaveBeenCalled();
    expect(res.details.jevReranked).toBe(false);
  });

  it("reranks when enabled and marks details", async () => {
    const transport = vi.fn(
      jsonTransport({
        answers: {
          best: {
            type: "choice",
            choice: "m1",
            probabilities: { m0: 0.7, m1: 0.2, m2: 0.1 },
            confidence: 0.6,
          },
        },
      }),
    );
    const [tool] = createMemoryTools({} as never, {
      adapter: adapter as never,
      memoryPath: "mem.jsonl",
      jev: { settings: settingsWith({ enabled: true, allowEgress: true }), transport },
    });
    const res = (await tool.execute("e1", { query: "bun wire" }, {} as never)) as {
      content: { type: string; text: string }[];
      details: { jevReranked: boolean; memoryIds: string[] };
    };
    expect(transport).toHaveBeenCalledTimes(1);
    expect(res.details.jevReranked).toBe(true);
    expect(res.details.memoryIds.length).toBeGreaterThan(0);
    // Formatted text order follows the rerank: top memory's text first.
    const firstId = res.details.memoryIds[0]!;
    const firstText =
      firstId === "m1" ? "vault project uses bun" : firstId === "m2" ? "favorite color blue" : "bun test runner preferred";
    expect(res.content[0]?.text.indexOf(firstText)).toBeGreaterThanOrEqual(0);
  });

  it("skips vault-scoped memories by default", async () => {
    const vaultJsonl = [JSON.stringify({ id: "v1", kind: "fact", text: "vault secret bun", scope: "vault" })].join("\n");
    const vaultAdapter = { exists: async () => true, read: async () => vaultJsonl };
    const transport = vi.fn(jsonTransport({ answers: {} }));
    const [tool] = createMemoryTools({} as never, {
      adapter: vaultAdapter as never,
      memoryPath: "mem.jsonl",
      jev: { settings: settingsWith({ enabled: true, allowEgress: true }), transport },
    });
    const res = (await tool.execute("e1", { query: "bun" }, {} as never)) as {
      details: { jevReranked: boolean };
    };
    expect(transport).not.toHaveBeenCalled();
    expect(res.details.jevReranked).toBe(false);
  });
});
