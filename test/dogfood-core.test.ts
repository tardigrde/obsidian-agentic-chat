import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  assertDogfoodInvariants,
  generateDogfoodVault,
  writeDogfoodRunReport,
  type DogfoodManifest,
} from "../scripts/dogfood-core";

const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function tempDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "agentic-chat-dogfood-core-"));
  tempRoots.push(root);
  return root;
}

describe("dogfood core", () => {
  it("generates an adversarial vault and validates a complete dogfood session", async () => {
    const root = await tempDir();
    const manifest = await generateDogfoodVault({
      vaultPath: path.join(root, "vault"),
      externalRoot: path.join(root, "external"),
      runId: "unit-dogfood",
    });
    await writeGeneratedNotes(manifest);
    await writeSession(manifest, validSessionEntries(manifest));

    const result = await assertDogfoodInvariants(manifest);
    const reportPath = await writeDogfoodRunReport(result, path.join(root, "reports"));

    expect(result.ok).toBe(true);
    expect(result.metrics.cacheHits).toBe(1);
    expect(result.metrics.toolStarts.write).toBeGreaterThanOrEqual(1);
    expect(reportPath).toContain("unit-dogfood-summary.md");
  });

  it("fails when restricted text leaks into session JSONL", async () => {
    const root = await tempDir();
    const manifest = await generateDogfoodVault({
      vaultPath: path.join(root, "vault"),
      externalRoot: path.join(root, "external"),
      runId: "unit-dogfood-leak",
    });
    await writeGeneratedNotes(manifest);
    await writeSession(manifest, [
      ...validSessionEntries(manifest),
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: manifest.secretText }] } },
    ]);

    const result = await assertDogfoodInvariants(manifest);

    expect(result.ok).toBe(false);
    expect(result.findings).toContainEqual(
      expect.objectContaining({ area: "privacy", message: "Restricted secret marker leaked into session JSONL." }),
    );
  });

  it("warns when external reads exceed an opt-in repeat threshold", async () => {
    const root = await tempDir();
    const manifest = await generateDogfoodVault({
      vaultPath: path.join(root, "vault"),
      externalRoot: path.join(root, "external"),
      runId: "unit-dogfood-repeated-reads",
    });
    manifest.maxRepeatedExternalReadCount = 1;
    await writeGeneratedNotes(manifest);
    await writeSession(manifest, validSessionEntries(manifest));

    const result = await assertDogfoodInvariants(manifest);

    expect(result.ok).toBe(true);
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        severity: "warning",
        area: "tool-efficiency",
        message: "External read foreign-vault/Imported.md was repeated 2 times, over warning threshold 1.",
      }),
    );
  });
});

async function writeGeneratedNotes(manifest: DogfoodManifest): Promise<void> {
  await writeVaultFile(
    manifest,
    "Generated/Oracle.md",
    [
      "---",
      "tags: [dogfood, oracle]",
      "source: external://foreign-vault/Imported.md",
      "verified: true",
      "---",
      "# Oracle",
      "See [[Generated/Oracle Companion]] and [[Messy/Target]].",
    ].join("\n"),
  );
  await writeVaultFile(
    manifest,
    "Generated/Oracle Companion.md",
    "---\ntags: [dogfood]\n---\n# Oracle Companion\n",
  );
  await writeVaultFile(
    manifest,
    "Generated/Reload Continuation.md",
    "---\ntags: [dogfood]\n---\n# Reload Continuation\nContinued after plugin reload.\n",
  );
  await writeVaultFile(
    manifest,
    "Generated/Double Click Approval.md",
    "---\ntags: [dogfood, approval]\n---\n# Double Click Approval\nApproved once despite a double click.\n",
  );
  await writeVaultFile(
    manifest,
    "Generated/Settings Race Allowed.md",
    "---\ntags: [dogfood, approval]\n---\n# Settings Race Allowed\nThe in-flight modal decision won.\n",
  );
  await writeVaultFile(
    manifest,
    "Generated/Batch Second.md",
    "---\ntags: [dogfood, approval]\n---\n# Batch Second\nThe second batch mutation still asked before running.\n",
  );
  await writeVaultFile(
    manifest,
    "Generated/New Session Continuation.md",
    "---\ntags: [dogfood, sessions]\n---\n# New Session Continuation\nScripted replay continued after /new.\n",
  );
}

async function writeVaultFile(manifest: DogfoodManifest, relativePath: string, content: string): Promise<void> {
  const target = path.join(manifest.vaultPath, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${content}\n`, "utf8");
}

async function writeSession(manifest: DogfoodManifest, entries: unknown[]): Promise<void> {
  const sessionDir = path.join(manifest.vaultPath, ".obsidian/plugins/agentic-chat/sessions");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    path.join(sessionDir, "2026-07-01T00-00-00-000Z_unit.jsonl"),
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8",
  );
}

function validSessionEntries(_manifest: DogfoodManifest): unknown[] {
  const toolNames = [
    "read",
    "vault_inspect",
    "write",
    "edit",
    "rename",
    "delete",
    "set_properties",
    "external_inspect",
    "search_memory",
    "ask_user",
  ];
  return [
    { type: "message", message: { role: "user", content: [{ type: "text", text: 'Active note "Dogfood Scratch.md":\n# Scratch' }] } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
    ...toolNames.map((toolName, index) => ({
      type: "action_audit",
      event: { category: "tool_call", action: "start", toolName, toolCallId: `tool-${index}`, args: toolName === "external_inspect" ? { action: "list", path: "" } : {} },
    })),
    {
      type: "action_audit",
      event: { category: "tool_call", action: "start", toolName: "external_inspect", toolCallId: "ext-1", args: { action: "read", path: "foreign-vault/Imported.md" } },
    },
    {
      type: "action_audit",
      event: { category: "tool_call", action: "start", toolName: "external_inspect", toolCallId: "ext-2", args: { action: "read", path: "foreign-vault/Imported.md" } },
    },
    { type: "message", message: { role: "toolResult", toolCallId: "ext-2", toolName: "external_inspect", details: { cached: true } } },
    ...mutationTriplet("write-1", "write", { kind: "write", path: "Generated/Oracle.md" }),
    ...mutationTriplet("set-props-1", "set_properties", { kind: "edit", path: "Generated/Oracle.md" }),
    ...mutationTriplet("edit-1", "edit", { kind: "edit", path: "Generated/Oracle.md" }),
    ...mutationTriplet("rename-1", "rename", { kind: "rename", from: "Generated/Rename Source.md", to: "Generated/Renamed.md" }),
    ...mutationTriplet("delete-1", "delete", { kind: "delete", path: "Generated/Old.md" }),
    {
      type: "action_audit",
      event: {
        category: "approval",
        action: "decision",
        decision: "denied",
        toolName: "write",
        toolCallId: "denied-write",
        diff: { kind: "write", path: "Generated/Denied Should Not Exist.md" },
      },
    },
  ];
}

function mutationTriplet(toolCallId: string, toolName: string, diff: Record<string, unknown>): unknown[] {
  return [
    { type: "action_audit", event: { category: "approval", action: "decision", decision: "auto-approved", toolName, toolCallId, diff } },
    { type: "file_checkpoint", checkpoint: { toolCallId } },
    { type: "action_audit", event: { category: "tool_call", action: "end", toolName, toolCallId, isError: false } },
  ];
}
