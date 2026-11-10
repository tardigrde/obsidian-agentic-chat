import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { ObsidianSessionManager } from "../src/session/session-manager";
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
const SEEDS = seeds(40);

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
  const tabA = new ObsidianSessionManager(data, "sessions", "vault:test");
  const tabB = new ObsidianSessionManager(data, "sessions", "vault:test");
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
        } catch {
          // A load that lands mid-rewrite may fail cleanly; it must not corrupt.
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
