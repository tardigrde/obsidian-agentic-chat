import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  ChaosGuardError,
  DEFAULT_CAPS,
  DEFAULT_DRY_RUN_CAPS,
  SEED_MARKER,
  TEMP_PREFIX,
  assertSafeVaultPath,
  assertSeedMarker,
  decideStop,
  estimateTokens,
  parseCaps,
  redactSecrets,
  selectMode,
} from "../scripts/chaos/monkey-core";

describe("chaos monkey caps", () => {
  it("uses the documented defaults when no cap is given", () => {
    expect(parseCaps({})).toEqual(DEFAULT_CAPS);
  });

  it("parses explicit caps from strings", () => {
    expect(parseCaps({ maxSteps: "3", maxSeconds: "45", maxCalls: "2", maxTokens: "1000" })).toEqual({
      maxSteps: 3,
      maxSeconds: 45,
      maxCalls: 2,
      maxTokens: 1000,
    });
  });

  it("rejects zero, negative, and fractional caps so a typo cannot remove them", () => {
    for (const value of ["0", "-1", "1.5", "many"]) {
      expect(() => parseCaps({ maxSteps: value })).toThrow(ChaosGuardError);
    }
  });

  it("keeps the dry-run default when the caller supplies it", () => {
    expect(parseCaps({ maxSteps: "2" }, DEFAULT_DRY_RUN_CAPS)).toEqual({
      ...DEFAULT_DRY_RUN_CAPS,
      maxSteps: 2,
    });
  });
});

describe("chaos monkey mode selection", () => {
  it("accepts every focused target", () => {
    for (const target of ["composer", "settings", "notes", "mcp"] as const) {
      expect(selectMode("focused", target)).toEqual({ mode: "focused", target });
    }
  });

  it("defaults to focused and requires a named target", () => {
    expect(() => selectMode(undefined, undefined)).toThrow(/needs --target/);
  });

  it("accepts generic without a target", () => {
    expect(selectMode("generic", undefined)).toEqual({ mode: "generic" });
  });

  it("rejects a target in generic mode and unknown values", () => {
    expect(() => selectMode("generic", "settings")).toThrow(ChaosGuardError);
    expect(() => selectMode("chaos", undefined)).toThrow(ChaosGuardError);
    expect(() => selectMode("focused", "browser")).toThrow(ChaosGuardError);
  });
});

const tempRoots: string[] = [];

function guardTempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "chaos-monkey-guard-"));
  tempRoots.push(root);
  return root;
}

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

describe("chaos monkey vault guard", () => {
  it("accepts a fresh directory under the temp root with the prefix", () => {
    const root = guardTempRoot();
    const vault = path.join(root, `${TEMP_PREFIX}run`, "vault");
    expect(assertSafeVaultPath(vault, root)).toBe(path.resolve(vault));
  });

  it("rejects a real vault, the temp root itself, and a path outside the temp root", () => {
    const root = guardTempRoot();
    for (const candidate of [
      path.join(os.homedir(), "MyTestVault"),
      root,
      path.join(root, "not-prefixed", "vault"),
      "/etc",
    ]) {
      expect(() => assertSafeVaultPath(candidate, root)).toThrow(ChaosGuardError);
    }
  });

  it("rejects the seeded home vault even when it is named like a plain folder", () => {
    expect(() => assertSafeVaultPath(path.join(os.homedir(), ".obsidian", "vault"), os.tmpdir())).toThrow(
      ChaosGuardError,
    );
  });

  it("requires the seed marker written by the runner", () => {
    const root = guardTempRoot();
    const marker = path.join(root, SEED_MARKER);
    expect(() => assertSeedMarker(marker)).toThrow(ChaosGuardError);
    writeFileSync(marker, "chaos-monkey\n");
    expect(() => assertSeedMarker(marker)).not.toThrow();
    writeFileSync(marker, "something else\n");
    expect(() => assertSeedMarker(marker)).toThrow(ChaosGuardError);
  });
});

describe("chaos monkey stop rule", () => {
  const caps = { maxSteps: 3, maxSeconds: 10, maxCalls: 2, maxTokens: 100 };

  it("continues while every cap has room", () => {
    expect(decideStop(caps, { startedAt: 0, steps: 1, calls: 1, tokens: 50, now: 1_000 })).toEqual({
      stop: false,
    });
  });

  it("stops on each cap and on cancel", () => {
    expect(decideStop(caps, { startedAt: 0, steps: 3, calls: 0, tokens: 0, now: 1000 })).toEqual({
      stop: true,
      reason: "max-steps",
    });
    expect(decideStop(caps, { startedAt: 0, steps: 0, calls: 0, tokens: 0, now: 10_000 })).toEqual({
      stop: true,
      reason: "max-seconds",
    });
    expect(decideStop(caps, { startedAt: 0, steps: 0, calls: 2, tokens: 0, now: 1000 })).toEqual({
      stop: true,
      reason: "max-calls",
    });
    expect(decideStop(caps, { startedAt: 0, steps: 0, calls: 0, tokens: 100, now: 1000 })).toEqual({
      stop: true,
      reason: "max-tokens",
    });
    expect(decideStop(caps, { startedAt: 0, steps: 0, calls: 0, tokens: 0, now: 1000, canceled: true })).toEqual({
      stop: true,
      reason: "canceled",
    });
  });
});

describe("chaos monkey redaction and token estimate", () => {
  it("replaces every secret and leaves short values alone", () => {
    expect(redactSecrets("key sk-live-123 and sk-live-123", ["sk-live-123", undefined, "ab"])).toBe(
      "key [redacted] and [redacted]",
    );
  });

  it("estimates tokens from characters and seconds", () => {
    expect(estimateTokens("a".repeat(400))).toBe(100);
    expect(estimateTokens("", 10)).toBe(40);
  });
});
