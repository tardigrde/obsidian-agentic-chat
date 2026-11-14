/**
 * Release fixture capture (#290). NOT part of the HEAD unit suite: the capture
 * script copies this file into a checkout of a release tag and runs it with
 * that release's own vitest config, so the saved shapes come from the code
 * that shipped. Use only APIs that every release has; probe the rest.
 */
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import * as schema from "../src/settings-schema";
import * as secrets from "../src/secrets/secret-store";
import * as sessions from "../src/session/session-manager";
import { MemoryAdapter } from "./helpers/memory-adapter";

const OUT = process.env.RELEASE_FIXTURE_OUT ?? "";
const FAKE_KEY = "fixture-not-a-real-key";

function secretMap(store: unknown): Map<string, string> {
  const record = store as Record<string, unknown>;
  for (const key of ["secrets", "values"]) {
    if (record[key] instanceof Map) return record[key] as Map<string, string>;
  }
  return new Map();
}

it("captures data.json and a session JSONL", async () => {
  if (!OUT) throw new Error("RELEASE_FIXTURE_OUT is not set");
  mkdirSync(path.join(OUT, "sessions"), { recursive: true });

  // data.json: defaults plus the choices a real user of this release could have made.
  const settings = structuredClone(schema.DEFAULT_SETTINGS) as Record<string, unknown> & {
    approval: Record<string, unknown>;
  };
  settings.provider = "openrouter";
  settings.openrouterApiKey = FAKE_KEY;
  if ("mode" in settings) settings.mode = "plan";
  if ("workingDirs" in settings.approval) settings.approval.workingDirs = ["Projects", "Journal"];
  // Non-default choices the upgrade test asserts survive the load (#284 class).
  settings.temperature = 0.7;
  settings.maxNetworkRetries = 4;
  settings.requestTimeoutMs = 45_000;
  settings.systemPrompt = "Fixture system prompt.";
  const store = new secrets.MemorySecretStore();
  const persisted = secrets.settingsForStorage(settings as never, store);
  writeFileSync(path.join(OUT, "data.json"), `${JSON.stringify(persisted, null, 2)}\n`);
  writeFileSync(
    path.join(OUT, "secrets.json"),
    `${JSON.stringify(Object.fromEntries(secretMap(store)), null, 2)}\n`,
  );

  // One session with every entry type this release can write.
  const adapter = new MemoryAdapter();
  const manager = new sessions.ObsidianSessionManager(
    adapter.asDataAdapter(),
    "sessions",
    "vault:fixture",
    // Releases after #365 require a registry; older ones default the fourth argument.
    (sessions.SessionWriteRegistry ? new sessions.SessionWriteRegistry() : undefined) as never,
  );
  await manager.createSession({ provider: "openrouter", modelId: "openai/gpt-4o-mini", thinkingLevel: "off" });
  await manager.appendMessage({ role: "user", content: [{ type: "text", text: "Summarize Projects/plan.md" }], timestamp: 1 } as never);
  await manager.appendMessage({
    role: "assistant",
    content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "Projects/plan.md" } }],
    api: "openai-completions",
    provider: "openrouter",
    model: "openai/gpt-4o-mini",
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: 2,
  } as never);
  await manager.appendMessage({
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "read",
    content: [{ type: "text", text: "# Plan\n- ship" }],
    isError: false,
    timestamp: 3,
  } as never);
  await manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "The plan is to ship." }],
    api: "openai-completions",
    provider: "openrouter",
    model: "openai/gpt-4o-mini",
    usage: { input: 20, output: 6, cacheRead: 0, cacheWrite: 0, totalTokens: 26, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: 4,
  } as never);
  await manager.appendModelChange("openrouter", "anthropic/claude-sonnet-4");
  await manager.appendThinkingLevelChange("low");
  await manager.appendSessionName("Fixture session");
  const optional = manager as unknown as Record<string, (arg: unknown) => Promise<unknown>>;
  if (typeof optional.appendPlanTracker === "function") {
    await optional.appendPlanTracker({
      version: 1,
      title: "Ship",
      items: [{ id: "1", title: "Write tests", status: "in_progress", testStatus: "not_run" }],
      updatedAt: "2026-11-01T00:00:00.000Z",
    });
  }
  for (const [file, content] of adapter.files) {
    // One session per capture, under a stable name the upgrade test reads.
    if (file.endsWith(".jsonl")) writeFileSync(path.join(OUT, "sessions", "fixture.jsonl"), content);
  }
  expect(readdirSync(path.join(OUT, "sessions"))).toEqual(["fixture.jsonl"]);
});
