import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { ObsidianSessionManager, SessionWriteRegistry } from "../src/session/session-manager";
import { MemoryAdapter } from "./helpers/memory-adapter";

const DEFAULTS = { provider: "openrouter", modelId: "x/y", thinkingLevel: "off" as const };

function userMessage(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 } as AgentMessage;
}

async function seededOwner(registry: SessionWriteRegistry): Promise<{
  adapter: MemoryAdapter;
  data: ReturnType<MemoryAdapter["asDataAdapter"]>;
  owner: ObsidianSessionManager;
}> {
  const adapter = new MemoryAdapter();
  const data = adapter.asDataAdapter();
  const owner = new ObsidianSessionManager(data, "sessions", "vault:test", registry);
  await owner.createSession(DEFAULTS);
  await owner.appendMessage(userMessage("first"));
  return { adapter, data, owner };
}

async function observeFirstTemp(
  adapter: MemoryAdapter,
  observe: (tempPath: string) => Promise<void>,
): Promise<void> {
  const originalWrite = adapter.write.bind(adapter);
  let seen = false;
  adapter.write = async (target, content) => {
    await originalWrite(target, content);
    if (target.includes(".tmp.") && !seen) {
      seen = true;
      await observe(target);
    }
  };
}

describe("SessionWriteRegistry", () => {
  it("lets managers with the same registry keep each other's in-flight temps", async () => {
    const registry = new SessionWriteRegistry();
    const { adapter, data, owner } = await seededOwner(registry);
    const sibling = new ObsidianSessionManager(data, "sessions", "vault:test", registry);

    await observeFirstTemp(adapter, async (tempPath) => {
      await sibling.listSessions();
      expect(adapter.files.has(tempPath)).toBe(true);
    });

    await expect(owner.rewriteMessages([userMessage("rewound")])).resolves.toBeUndefined();
  });

  it("keeps managers with different registries apart", async () => {
    const { adapter, data, owner } = await seededOwner(new SessionWriteRegistry());
    const outsider = new ObsidianSessionManager(data, "sessions", "vault:test", new SessionWriteRegistry());

    await observeFirstTemp(adapter, async (tempPath) => {
      await outsider.listSessions();
      expect(adapter.files.has(tempPath)).toBe(false);
    });

    // The outsider removed the temp, so the owner's replace cannot complete.
    await expect(owner.rewriteMessages([userMessage("rewound")])).rejects.toThrow();
  });
});
