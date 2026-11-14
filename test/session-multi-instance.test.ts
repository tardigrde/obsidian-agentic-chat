import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { ObsidianSessionManager, SessionWriteRegistry } from "../src/session/session-manager";
import { parseSessionEntries } from "../src/session/jsonl";
import { MemoryAdapter } from "./helpers/memory-adapter";
import { interleaveAdapter, seeds } from "./helpers/interleave";

/**
 * Multi-instance harness (#290): two chat tabs build their own session manager
 * over one session folder. Each scenario runs under many seeded interleavings
 * of adapter awaits, in both rename modes, and checks invariants that must hold
 * for every ordering. The bug class is #279.
 */

const DEFAULTS = { provider: "openrouter", modelId: "x/y", thinkingLevel: "off" as const };
// 300 seeds: fewer missed the overwrite-mode #279 races and the restore race
// below. INTERLEAVE_SEEDS=1000 explores more locally.
const SEEDS = seeds(Number(process.env.INTERLEAVE_SEEDS ?? 300));
/** The only clean ways a load may fail while another tab rewrites. */
const CLEAN_LOAD_ERRORS = /^Error: (Session file is being replaced\.|Not found: sessions\/)/;

function userMessage(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 } as AgentMessage;
}

function texts(content: string | undefined): string[] {
  return parseSessionEntries(content ?? "")
    .filter((entry) => entry.type === "message")
    .map((entry) => {
      const blocks = (entry as { message: { content: Array<{ text?: string }> } }).message.content;
      return blocks.map((block) => block.text ?? "").join("");
    });
}

/** Leftover rewrite temps and backups in the folder. */
function artifacts(adapter: MemoryAdapter): string[] {
  return [...adapter.files.keys()].filter((file) => file.includes(".tmp.") || file.endsWith(".bak"));
}

/** Obsidian desktop's rename refuses an existing target, which forces the `.bak` path. */
function refuseOverwrite(adapter: MemoryAdapter): void {
  const rename = adapter.rename.bind(adapter);
  adapter.rename = async (from, to) => {
    if (adapter.files.has(to)) throw new Error("Destination file already exists!");
    return rename(from, to);
  };
}

async function twoTabs(seed: number, overwrite: boolean) {
  const adapter = new MemoryAdapter();
  if (!overwrite) refuseOverwrite(adapter);
  const data = adapter.asDataAdapter();
  const registry = new SessionWriteRegistry();
  const tabA = new ObsidianSessionManager(data, "sessions", "vault:test", registry);
  const tabB = new ObsidianSessionManager(data, "sessions", "vault:test", registry);
  const info = await tabA.createSession(DEFAULTS);
  await tabA.appendMessage(userMessage("first"));
  await tabA.appendMessage(userMessage("second"));
  // Interleave only the racing part; setup is sequential.
  interleaveAdapter(adapter, seed);
  return { adapter, tabA, tabB, path: info.path };
}

describe.each([
  ["rename overwrites", true],
  ["rename refuses an existing target", false],
])("two tabs over one session folder (%s)", (_mode, overwrite) => {
  it.each(SEEDS)("rewrite in tab A vs new session in tab B (seed %i)", async (seed) => {
    const { adapter, tabA, tabB, path } = await twoTabs(seed, overwrite);

    const [, created] = await Promise.all([
      tabA.rewriteMessages([userMessage("rewound")]),
      tabB.createSession(DEFAULTS).then(async (info) => {
        await tabB.appendMessage(userMessage("tab B"));
        return info;
      }),
    ]);

    expect(texts(adapter.files.get(path))).toEqual(["rewound"]);
    expect(texts(adapter.files.get(created.path))).toEqual(["tab B"]);
    expect(artifacts(adapter)).toEqual([]);
  });

  it.each(SEEDS)("rewrite in tab A vs list and load in tab B (seed %i)", async (seed) => {
    const { adapter, tabA, tabB, path } = await twoTabs(seed, overwrite);

    const [, seen] = await Promise.all([
      tabA.rewriteMessages([userMessage("rewound")]),
      (async () => {
        await tabB.listSessions();
        try {
          await tabB.loadSession(path);
          return tabB.buildSessionContext().messages.length;
        } catch (error) {
          // A load that lands mid-rewrite may fail cleanly; it must not corrupt.
          expect(String(error)).toMatch(CLEAN_LOAD_ERRORS);
          return null;
        }
      })(),
    ]);

    expect(texts(adapter.files.get(path))).toEqual(["rewound"]);
    expect(artifacts(adapter)).toEqual([]);
    // Tab B sees the old or the new transcript, never a partial one.
    if (seen !== null) expect([1, 2]).toContain(seen);
  });
});

describe("interleave helper", () => {
  it("wraps every adapter method and replays the same schedule for a seed", async () => {
    const adapter = new MemoryAdapter();
    const original = adapter.write;
    interleaveAdapter(adapter, 7);
    expect(adapter.write).not.toBe(original);
    expect(adapter.asDataAdapter().write).toBe(adapter.write);

    // Two actors racing on the same seed must finish in the same order.
    async function order(seed: number): Promise<string[]> {
      const raced = interleaveAdapter(new MemoryAdapter(), seed);
      const done: string[] = [];
      await Promise.all(
        ["a", "b", "c", "d"].map(async (name) => {
          await raced.write(name, name);
          await raced.read(name);
          done.push(name);
        }),
      );
      return done;
    }
    expect(await order(11)).toEqual(await order(11));
    const orders = new Set(await Promise.all(seeds(20).map(async (seed) => (await order(seed)).join(""))));
    expect(orders.size).toBeGreaterThan(1);
  });
});
