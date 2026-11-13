import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, mergeSettings } from "../src/settings-schema";

type Json = Record<string, unknown>;
type Leaf = { path: string[]; value: unknown };

/** Every primitive leaf of the default settings, including nested groups. */
function primitiveLeaves(node: unknown, path: string[] = [], out: Leaf[] = []): Leaf[] {
  if (Array.isArray(node)) return out;
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node as Json)) primitiveLeaves(value, [...path, key], out);
    return out;
  }
  out.push({ path, value: node });
  return out;
}

function wrongType(value: unknown): unknown {
  if (typeof value === "string") return 42;
  if (typeof value === "number") return "not-a-number";
  if (typeof value === "boolean") return "yes";
  throw new Error(`No wrong-type fixture for ${typeof value}`);
}

function read(root: unknown, path: string[]): unknown {
  return path.reduce<unknown>((value, part) => (value as Json | undefined)?.[part], root);
}

function write(root: Json, path: string[], value: unknown): void {
  let target = root;
  for (const part of path.slice(0, -1)) target = target[part] as Json;
  target[path[path.length - 1]] = value;
}

const leaves = primitiveLeaves(DEFAULT_SETTINGS);

describe("mergeSettings heals every primitive leaf", () => {
  it("walks a broad table of defaults", () => {
    expect(leaves.length).toBeGreaterThan(40);
  });

  for (const leaf of leaves) {
    const name = leaf.path.join(".");
    it(`heals ${name} to its default when the stored type is wrong`, () => {
      const stored = structuredClone(DEFAULT_SETTINGS) as unknown as Json;
      write(stored, leaf.path, wrongType(leaf.value));
      const merged = mergeSettings(stored as never) as unknown as Json;
      expect(read(merged, leaf.path), `${name} <- ${typeof wrongType(leaf.value)}`).toBe(leaf.value);
    });
  }

  it("heals the corrupt leaves named by the audit", () => {
    const merged = mergeSettings({
      temperature: "hot",
      requestTimeoutMs: -5,
      maxTokens: -1,
      maxNetworkRetries: 9,
      thinkingLevel: "ultra",
      ignoredGlobs: ["Private/"],
      openrouterModel: 42,
      ollamaModel: { id: "llama3.1" },
      notifications: { enabled: "yes", costAlertUsd: "x", costCapUsd: -1 },
      compaction: { enabled: "yes", thresholdPercent: 99 },
    } as never);

    expect(merged.temperature).toBe(DEFAULT_SETTINGS.temperature);
    expect(merged.requestTimeoutMs).toBe(DEFAULT_SETTINGS.requestTimeoutMs);
    expect(merged.maxTokens).toBe(DEFAULT_SETTINGS.maxTokens);
    expect(merged.maxNetworkRetries).toBe(DEFAULT_SETTINGS.maxNetworkRetries);
    expect(merged.thinkingLevel).toBe(DEFAULT_SETTINGS.thinkingLevel);
    expect(merged.ignoredGlobs).toBe(DEFAULT_SETTINGS.ignoredGlobs);
    expect(merged.openrouterModel).toBe(DEFAULT_SETTINGS.openrouterModel);
    expect(merged.ollamaModel).toBe(DEFAULT_SETTINGS.ollamaModel);
    expect(merged.notifications).toEqual(DEFAULT_SETTINGS.notifications);
    expect(merged.compaction).toEqual(DEFAULT_SETTINGS.compaction);
  });
});
