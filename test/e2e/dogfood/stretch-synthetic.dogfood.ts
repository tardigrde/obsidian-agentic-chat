import { browser, expect, $ } from "@wdio/globals";
import { after, before, describe, it } from "mocha";

const TURN_TIMEOUT_MS = Number(process.env.DOGFOOD_TURN_TIMEOUT_MS || 120_000);
const EXTERNAL_ROOT = process.env.DOGFOOD_EXTERNAL_ROOT?.trim() || "/tmp/agentic-chat-dogfood-external-root";
const SECRET_TEXT = "SYNTHETIC_SECRET_DO_NOT_LEAK";

type ScriptedTurn = {
  label?: string;
  content: Array<Record<string, unknown>>;
  stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted";
  delayMs?: number;
  usage?: Record<string, unknown>;
};

type SettingsPlugin = {
  settings?: Record<string, unknown>;
  saveSettings?: () => Promise<void>;
};

function textTurn(label: string, text: string): ScriptedTurn {
  return { label, stopReason: "stop", content: [{ type: "text", text }] };
}

function toolBatch(label: string, calls: Array<{ id: string; name: string; args: Record<string, unknown> }>): ScriptedTurn {
  return {
    label,
    stopReason: "toolUse",
    content: calls.map((call) => ({ type: "toolCall", id: call.id, name: call.name, arguments: call.args })),
  };
}

async function installScriptedTurns(turns: ScriptedTurn[]): Promise<void> {
  await browser.execute((scriptedTurns) => {
    const target = window as typeof window & {
      __AGENTIC_CHAT_E2E_TURNS__?: ScriptedTurn[];
      __AGENTIC_CHAT_E2E_CALLS__?: number;
      __AGENTIC_CHAT_E2E_CALL_LOG__?: unknown[];
    };
    target.__AGENTIC_CHAT_E2E_TURNS__ = scriptedTurns;
    target.__AGENTIC_CHAT_E2E_CALLS__ = 0;
    target.__AGENTIC_CHAT_E2E_CALL_LOG__ = [];
  }, turns);
}

async function openChat(): Promise<void> {
  await browser.executeObsidianCommand("agentic-chat:open-chat");
  await $(".agentic-chat-view").waitForExist();
}

async function sendPrompt(prompt: string): Promise<void> {
  await browser.execute((value) => {
    const textarea = document.querySelector<HTMLTextAreaElement>(".agentic-chat-input");
    const send = document.querySelector<HTMLButtonElement>(".agentic-chat-send");
    if (!textarea || !send) throw new Error("agentic-chat composer is not mounted");
    textarea.value = value;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    send.click();
  }, prompt);
}

async function runSlashCommand(command: string): Promise<string> {
  const before = await transcriptText();
  await sendPrompt(command);
  await browser.waitUntil(async () => (await transcriptText()) !== before, {
    timeout: 10_000,
    timeoutMsg: `${command} did not update the transcript`,
  });
  return await transcriptText();
}

async function waitForTurnToFinish(): Promise<void> {
  await browser.waitUntil(
    async () => {
      const stopVisible = await $(".agentic-chat-stop").isDisplayed().catch(() => false);
      const approvalOpen = await $(".agentic-chat-approval").isExisting().catch(() => false);
      const askUserOpen = await $(".agentic-chat-ask-user").isExisting().catch(() => false);
      return !stopVisible && !approvalOpen && !askUserOpen;
    },
    { timeout: TURN_TIMEOUT_MS, timeoutMsg: "synthetic dogfood turn did not finish" },
  );
}

async function answerAskUser(answer: string): Promise<void> {
  const askUser = await $(".agentic-chat-ask-user");
  await askUser.waitForExist({ timeout: 10_000 });
  await browser.execute((value) => {
    const prompt = document.querySelector<HTMLElement>(".agentic-chat-ask-user");
    const textarea = prompt?.querySelector<HTMLTextAreaElement>(".agentic-chat-ask-input");
    const submit = prompt?.querySelector<HTMLButtonElement>(".agentic-chat-ask-submit");
    if (!textarea || !submit) throw new Error("ask_user prompt controls are not mounted");
    textarea.value = value;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    submit.click();
  }, answer);
  await askUser.waitForExist({ reverse: true, timeout: 10_000 });
}

async function runPrompt(prompt: string): Promise<void> {
  await sendPrompt(prompt);
  await waitForTurnToFinish();
}

async function transcriptText(): Promise<string> {
  return await browser.execute(() => document.querySelector<HTMLElement>(".agentic-chat-messages")?.innerText ?? "");
}

async function configurePlugin(): Promise<boolean> {
  return await browser.executeObsidian(async ({ app }, externalRoot) => {
    const plugin = (app as unknown as {
      plugins?: { plugins?: Record<string, SettingsPlugin> };
    }).plugins?.plugins?.["agentic-chat"];
    if (!plugin?.settings) return false;
    const settings = plugin.settings as {
      provider: string;
      openrouterApiKey: string;
      mode: string;
      enableBuiltinAgents: boolean;
      ignoredGlobs: string;
      approval: { mutating: string; perTool: Record<string, string>; workingDirs: string[] };
      external: { enabled: boolean; rootPath: string; approval: string; honorGitignore: boolean; ignoredGlobs: string };
      toolBudget: { enabled: boolean; thresholdPercent: number };
      web: { enabled: boolean };
      mcp: { enabled: boolean; servers: unknown[]; proxyUrl: string; noProxy: string };
    };
    settings.provider = "openrouter";
    settings.openrouterApiKey = "e2e-stretch-scripted-key";
    settings.mode = "safe";
    settings.enableBuiltinAgents = false;
    settings.ignoredGlobs = ["Restricted/**", "*.secret.md"].join("\n");
    settings.approval.mutating = "allow";
    settings.approval.perTool = {};
    settings.approval.workingDirs = [];
    settings.external.enabled = true;
    settings.external.rootPath = externalRoot;
    settings.external.approval = "allow";
    settings.external.honorGitignore = true;
    settings.external.ignoredGlobs = [".env", ".env.*", "*.key", "*.pem"].join("\n");
    settings.toolBudget.enabled = false;
    settings.toolBudget.thresholdPercent = 25;
    settings.web.enabled = false;
    settings.mcp = { enabled: false, proxyUrl: "", noProxy: "localhost,127.0.0.1,::1", servers: [] };
    await plugin.saveSettings?.();
    return true;
  }, EXTERNAL_ROOT);
}

async function setChaosSettings(): Promise<void> {
  await browser.executeObsidian(async ({ app }) => {
    const plugin = (app as unknown as {
      plugins?: { plugins?: Record<string, SettingsPlugin> };
    }).plugins?.plugins?.["agentic-chat"];
    if (!plugin?.settings) throw new Error("agentic-chat plugin not found");
    const settings = plugin.settings as {
      approval: { perTool: Record<string, string> };
      external: { approval: string };
      toolBudget: { enabled: boolean; thresholdPercent: number };
    };
    settings.approval.perTool = { ...settings.approval.perTool, write: "deny" };
    settings.external.approval = "deny";
    settings.toolBudget.enabled = true;
    settings.toolBudget.thresholdPercent = 1;
    await plugin.saveSettings?.();
  });
}

async function restoreSafeSettings(): Promise<void> {
  await browser.executeObsidian(async ({ app }) => {
    const plugin = (app as unknown as {
      plugins?: { plugins?: Record<string, SettingsPlugin> };
    }).plugins?.plugins?.["agentic-chat"];
    if (!plugin?.settings) throw new Error("agentic-chat plugin not found");
    const settings = plugin.settings as {
      approval: { perTool: Record<string, string> };
      external: { approval: string };
      toolBudget: { enabled: boolean; thresholdPercent: number };
    };
    settings.approval.perTool = {};
    settings.external.approval = "allow";
    settings.toolBudget.enabled = false;
    settings.toolBudget.thresholdPercent = 25;
    await plugin.saveSettings?.();
  });
}

async function seedVaultShapes(): Promise<void> {
  await browser.executeObsidian(async ({ app, obsidian }, secretText) => {
    const ensureFolder = async (folderPath: string) => {
      const parts = folderPath.split("/");
      let current = "";
      for (const part of parts) {
        current = current ? `${current}/${part}` : part;
        if (!app.vault.getAbstractFileByPath(current)) await app.vault.createFolder(current);
      }
    };
    const upsert = async (notePath: string, body: string) => {
      const folder = notePath.split("/").slice(0, -1).join("/");
      if (folder) await ensureFolder(folder);
      const existing = app.vault.getAbstractFileByPath(notePath);
      if (existing instanceof obsidian.TFile) await app.vault.modify(existing, body);
      else await app.vault.create(notePath, body);
    };

    await ensureFolder("Empty");
    await upsert("Messy/Home.md", "---\ntags: [messy]\n---\n# Messy Home\nSee [[Messy/Target]]. OAuth duplicate cleanup.\n");
    await upsert("Messy/Target.md", "# Target\nBacklink target for local graph.\n");
    await upsert("Messy/Duplicate stale.md", "# Duplicate\nDelete me during cleanup.\n");
    await upsert("Large/Huge.md", `# Huge\n\n${Array.from({ length: 260 }, (_, index) => `Line ${index + 1} OAuth context`).join("\n")}\n`);
    await upsert("Restricted/Secret.secret.md", `# Secret\n${secretText}\n`);
    await upsert("Multilingual/Árvíztűrő tükörfúrógép.md", "# Árvíztűrő\nMultilingual workspace note with English und magyar content.\n");
    await upsert("Dogfood Scratch.md", "# Synthetic Dogfood Scratch\n\nSafe active note for synthetic dogfood.\n");
    const file = app.vault.getAbstractFileByPath("Dogfood Scratch.md");
    if (!(file instanceof obsidian.TFile)) throw new Error("scratch note missing");
    await app.workspace.getLeaf(false).openFile(file);

    const adapter = app.vault.adapter as unknown as {
      exists: (path: string) => Promise<boolean>;
      mkdir: (path: string) => Promise<void>;
      write: (path: string, data: string) => Promise<void>;
    };
    const memoryDir = `${app.vault.configDir}/plugins/agentic-chat/memory`;
    if (!(await adapter.exists(memoryDir))) await adapter.mkdir(memoryDir);
    await adapter.write(
      `${memoryDir}/memories.jsonl`,
      `${JSON.stringify({
        id: "mem-stretch",
        kind: "fact",
        scope: "vault",
        text: "Synthetic dogfood user is validating a DevOps knowledge-base workflow.",
        enabled: true,
        createdAt: "2026-07-01T00:00:00.000Z",
      })}\n`,
    );
  }, SECRET_TEXT);
}

async function openRestrictedNote(): Promise<void> {
  await browser.executeObsidian(async ({ app, obsidian }) => {
    const file = app.vault.getAbstractFileByPath("Restricted/Secret.secret.md");
    if (!(file instanceof obsidian.TFile)) throw new Error("restricted note missing");
    await app.workspace.getLeaf(false).openFile(file);
  });
}

async function activeFilePath(): Promise<string | null> {
  return await browser.executeObsidian(async ({ app }) => app.workspace.getActiveFile()?.path ?? null);
}

async function noteExists(path: string): Promise<boolean> {
  return await browser.executeObsidian(async ({ app }, notePath) => app.vault.getAbstractFileByPath(notePath) != null, path);
}

async function readNote(path: string): Promise<string> {
  return await browser.executeObsidian(async ({ app, obsidian }, notePath) => {
    const file = app.vault.getAbstractFileByPath(notePath);
    if (!(file instanceof obsidian.TFile)) return "";
    return await app.vault.read(file);
  }, path);
}

async function latestSessionText(): Promise<string> {
  return await browser.executeObsidian(async ({ app }) => {
    const sessionDir = `${app.vault.configDir}/plugins/agentic-chat/sessions`;
    const listing = await app.vault.adapter.list(sessionDir);
    const latest = listing.files.filter((path) => path.endsWith(".jsonl")).sort().at(-1);
    return latest ? await app.vault.adapter.read(latest) : "";
  });
}

async function scriptedCallLabels(): Promise<string[]> {
  return await browser.execute(() => {
    const target = window as typeof window & {
      __AGENTIC_CHAT_E2E_CALL_LOG__?: Array<{ label?: string }>;
    };
    return target.__AGENTIC_CHAT_E2E_CALL_LOG__?.map((call) => call.label ?? "") ?? [];
  });
}

async function scriptedToolNamesByCall(): Promise<string[][]> {
  return await browser.execute(() => {
    const target = window as typeof window & {
      __AGENTIC_CHAT_E2E_CALL_LOG__?: Array<{ toolNames?: string[] }>;
    };
    return target.__AGENTIC_CHAT_E2E_CALL_LOG__?.map((call) => call.toolNames ?? []) ?? [];
  });
}

async function sessionStats(): Promise<{
  toolStarts: Record<string, number>;
  toolErrors: Record<string, number>;
  approvalDecisions: Record<string, number>;
  maxUserMessageChars: number;
}> {
  return await browser.executeObsidian(async ({ app }) => {
    const sessionDir = `${app.vault.configDir}/plugins/agentic-chat/sessions`;
    const listing = await app.vault.adapter.list(sessionDir);
    const latest = listing.files.filter((path) => path.endsWith(".jsonl")).sort().at(-1);
    const stats = {
      toolStarts: {} as Record<string, number>,
      toolErrors: {} as Record<string, number>,
      approvalDecisions: {} as Record<string, number>,
      maxUserMessageChars: 0,
    };
    if (!latest) return stats;
    const raw = await app.vault.adapter.read(latest);
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line) as {
        type?: string;
        message?: { role?: string; content?: Array<{ text?: string }> };
        event?: { category?: string; action?: string; toolName?: string; decision?: string; isError?: boolean };
      };
      if (entry.type === "message" && entry.message?.role === "user") {
        const text = (entry.message.content ?? []).map((part) => part.text ?? "").join("\n");
        stats.maxUserMessageChars = Math.max(stats.maxUserMessageChars, text.length);
      }
      const event = entry.event;
      if (entry.type !== "action_audit" || !event) continue;
      if (event.category === "tool_call" && event.action === "start" && event.toolName) {
        stats.toolStarts[event.toolName] = (stats.toolStarts[event.toolName] ?? 0) + 1;
      }
      if (event.category === "tool_call" && event.action === "end" && event.toolName && event.isError) {
        stats.toolErrors[event.toolName] = (stats.toolErrors[event.toolName] ?? 0) + 1;
      }
      if (event.category === "approval" && event.action === "decision" && event.toolName && event.decision) {
        const key = `${event.toolName}:${event.decision}`;
        stats.approvalDecisions[key] = (stats.approvalDecisions[key] ?? 0) + 1;
      }
    }
    return stats;
  });
}

function scriptedTurns(): ScriptedTurn[] {
  return [
    toolBatch("matrix tools", [
      { id: "m-list-root", name: "vault_inspect", args: { action: "list", path: "" } },
      { id: "m-search", name: "vault_inspect", args: { action: "search", query: "OAuth", kind: "content", path: "Messy", maxMatches: 5 } },
      { id: "m-active", name: "vault_inspect", args: { action: "active_note", includeContent: true } },
      { id: "m-graph", name: "vault_inspect", args: { action: "local_graph", path: "Messy/Target.md" } },
      { id: "m-props", name: "vault_inspect", args: { action: "properties", path: "Messy/Home.md" } },
      { id: "m-read", name: "read", args: { path: "Messy/Home.md" } },
      { id: "m-memory", name: "search_memory", args: { query: "DevOps knowledge-base", scope: "vault", maxResults: 3 } },
      { id: "m-ext-list", name: "external_inspect", args: { action: "list", path: "" } },
      { id: "m-ext-read", name: "external_inspect", args: { action: "read", path: "foreign-vault/Imported.md" } },
      { id: "m-ext-search", name: "external_inspect", args: { action: "search", path: "", query: "migration source", kind: "content", maxMatches: 5 } },
      {
        id: "m-write",
        name: "write",
        args: {
          path: "Dogfood Output/Matrix.md",
          content: "---\ntags: [dogfood, matrix]\nnote_type: dogfood\n---\n# Matrix\nInitial matrix note.\n",
        },
      },
      { id: "m-set-props", name: "set_properties", args: { path: "Dogfood Output/Matrix.md", properties: { verified: true, stale: null } } },
      {
        id: "m-edit",
        name: "edit",
        args: { path: "Dogfood Output/Matrix.md", edits: [{ oldText: "Initial matrix note.", newText: "Initial matrix note refined." }] },
      },
      { id: "m-rename", name: "rename", args: { path: "Dogfood Output/Matrix.md", newPath: "Dogfood Output/Matrix Final.md" } },
      { id: "m-delete", name: "delete", args: { path: "Messy/Duplicate stale.md" } },
    ]),
    textTurn("matrix final", "Synthetic matrix complete."),
    toolBatch("cache replay", [
      { id: "cache-read-foreign", name: "external_inspect", args: { action: "read", path: "foreign-vault/Imported.md" } },
    ]),
    textTurn("cache final", "External cache replay complete."),
    toolBatch("restricted active note", [
      { id: "r-active", name: "vault_inspect", args: { action: "active_note", includeContent: true } },
    ]),
    textTurn("restricted final", "Restricted active note stayed hidden."),
    toolBatch("ambiguous ask", [
      {
        id: "a-ask",
        name: "ask_user",
        args: { question: "Which dogfood notes should be cleaned?", choices: ["Only stale duplicates", "Cancel cleanup"] },
      },
    ]),
    textTurn("ask final", "Clarification was honored; cleanup stayed scoped."),
    toolBatch("chaos denied tools", [
      { id: "c-ext-deny", name: "external_inspect", args: { action: "read", path: "foreign-vault/Imported.md" } },
      { id: "c-write-deny", name: "write", args: { path: "Dogfood Output/Chaos Should Not Exist.md", content: "denied" } },
    ]),
    textTurn("chaos final", "Chaos settings denied risky tools cleanly."),
    toolBatch("long create", [
      {
        id: "l-write-index",
        name: "write",
        args: {
          path: "Long Workflow/Index.md",
          content: "---\ntags: [dogfood, long]\n---\n# Long Workflow\nSee [[Long Workflow/Duplicate]].\nNeeds refinement.\n",
        },
      },
      { id: "l-write-dup", name: "write", args: { path: "Long Workflow/Duplicate.md", content: "# Duplicate\nUseful detail: retain this.\n" } },
    ]),
    textTurn("long create final", "Long workflow draft created."),
    toolBatch("long refine", [
      { id: "l-read", name: "read", args: { path: "Long Workflow/Index.md" } },
      {
        id: "l-edit",
        name: "edit",
        args: {
          path: "Long Workflow/Index.md",
          edits: [{ oldText: "Needs refinement.", newText: "Refined with useful detail: retain this." }],
        },
      },
      { id: "l-delete", name: "delete", args: { path: "Long Workflow/Duplicate.md" } },
      {
        id: "l-write-qa",
        name: "write",
        args: { path: "Long Workflow/QA.md", content: "---\ntags: [dogfood, qa]\n---\n# QA\nBacklinks and duplicate cleanup verified.\n" },
      },
      { id: "l-graph", name: "vault_inspect", args: { action: "local_graph", path: "Long Workflow/Index.md" } },
    ]),
    textTurn("long refine final", "Long workflow refined and stale duplicate removed."),
    toolBatch("migration import", [
      { id: "x-read-foreign", name: "external_inspect", args: { action: "read", path: "foreign-vault/Imported.md" } },
      {
        id: "x-write-import",
        name: "write",
        args: {
          path: "Imported/Foreign Vault Imported.md",
          content: "---\ntags: [dogfood, migration]\nsource: external://foreign-vault/Imported.md\n---\n# Imported\nMigrated from external foreign vault.\n",
        },
      },
    ]),
    textTurn("migration final", "Cross-vault import finished."),
  ];
}

describe("agentic-chat stretched synthetic dogfood", function () {
  before(async function () {
    await installScriptedTurns(scriptedTurns());
    const configured = await configurePlugin();
    if (!configured) throw new Error("agentic-chat plugin not found in the synthetic dogfood vault");
    await seedVaultShapes();
    await openChat();
  });

  it("exercises multiple vault shapes and the default tool matrix", async function () {
    await runPrompt("Use every relevant default tool to inspect this synthetic vault and build the dogfood matrix note.");

    expect(await noteExists("Dogfood Output/Matrix Final.md")).toBe(true);
    expect(await noteExists("Messy/Duplicate stale.md")).toBe(false);
    const matrix = await readNote("Dogfood Output/Matrix Final.md");
    expect(matrix).toContain("Initial matrix note refined.");
    expect(matrix).toContain("verified: true");

    const toolNames = (await scriptedToolNamesByCall())[0] ?? [];
    for (const expected of ["read", "vault_inspect", "write", "edit", "rename", "delete", "set_properties", "external_inspect", "search_memory", "ask_user"]) {
      expect(toolNames).toContain(expected);
    }
  });

  it("observes repeated external reads as cache hits", async function () {
    await runPrompt("Read the same external imported note again to verify cache observability.");

    const raw = await latestSessionText();
    expect(raw).toContain('"cached":true');
  });

  it("keeps ignored active notes private in restricted vault shape", async function () {
    await openRestrictedNote();
    await runPrompt("This active note may be private; inspect it only if allowed.");

    const raw = await latestSessionText();
    expect(raw).not.toContain(SECRET_TEXT);
    expect(raw).toContain("No active Markdown note.");
  });

  it("routes unclear cleanup through ask_user and honors the answer", async function () {
    await sendPrompt("Clean this up, but I will not say what should be deleted.");
    await answerAskUser("Only stale duplicates; do not delete anything else.");
    await waitForTurnToFinish();

    expect(await transcriptText()).toContain("Clarification was honored");
  });

  it("survives chaos settings and then restores safe behavior", async function () {
    await setChaosSettings();
    const diagnostics = await runSlashCommand("/diagnostics");
    expect(diagnostics).toContain("Tool budget");
    expect(diagnostics).toContain("active");

    await runPrompt("Try an external read and write while chaos settings deny them.");
    expect(await noteExists("Dogfood Output/Chaos Should Not Exist.md")).toBe(false);

    const stats = await sessionStats();
    expect(stats.approvalDecisions["external_inspect:denied"]).toBeGreaterThanOrEqual(1);
    expect(stats.approvalDecisions["write:denied"]).toBeGreaterThanOrEqual(1);

    await restoreSafeSettings();
  });

  it("runs a long create/refine/delete/backlink workflow and exports without stealing context", async function () {
    await browser.executeObsidian(async ({ app, obsidian }) => {
      const file = app.vault.getAbstractFileByPath("Dogfood Scratch.md");
      if (!(file instanceof obsidian.TFile)) throw new Error("scratch note missing");
      await app.workspace.getLeaf(false).openFile(file);
    });

    await runPrompt("Create long workflow notes that will need refinement.");
    const exported = await runSlashCommand("/export");
    expect(exported).toContain("Export");
    expect(await activeFilePath()).toBe("Dogfood Scratch.md");

    await runPrompt("Read the long workflow notes, refine the kept note, delete stale duplicates, and write a QA note.");
    expect(await noteExists("Long Workflow/Index.md")).toBe(true);
    expect(await noteExists("Long Workflow/Duplicate.md")).toBe(false);
    expect(await noteExists("Long Workflow/QA.md")).toBe(true);
    expect(await readNote("Long Workflow/Index.md")).toContain("Refined with useful detail");
  });

  it("imports a note from a foreign vault-shaped external root", async function () {
    await runPrompt("Import the selected note from the external foreign vault into this vault.");

    expect(await noteExists("Imported/Foreign Vault Imported.md")).toBe(true);
    const imported = await readNote("Imported/Foreign Vault Imported.md");
    expect(imported).toContain("external://foreign-vault/Imported.md");
  });

  it("keeps replay and observability evidence within rough-edge thresholds", async function () {
    const labels = await scriptedCallLabels();
    expect(labels).toEqual([
      "matrix tools",
      "matrix final",
      "cache replay",
      "cache final",
      "restricted active note",
      "restricted final",
      "ambiguous ask",
      "ask final",
      "chaos denied tools",
      "chaos final",
      "long create",
      "long create final",
      "long refine",
      "long refine final",
      "migration import",
      "migration final",
    ]);

    const raw = await latestSessionText();
    expect(raw).toContain('"cached":true');
    expect(raw).not.toContain(SECRET_TEXT);

    const stats = await sessionStats();
    expect(stats.maxUserMessageChars).toBeLessThan(2_500);
    for (const tool of ["read", "vault_inspect", "write", "edit", "rename", "delete", "set_properties", "external_inspect", "search_memory", "ask_user"]) {
      expect(stats.toolStarts[tool]).toBeGreaterThanOrEqual(1);
    }
    expect(stats.toolErrors.external_inspect).toBeGreaterThanOrEqual(1);
    expect(stats.toolErrors.write).toBeGreaterThanOrEqual(1);
  });

  after(async function () {
    await restoreSafeSettings().catch(() => undefined);
    await browser.execute(() => {
      const target = window as typeof window & {
        __AGENTIC_CHAT_E2E_TURNS__?: ScriptedTurn[];
        __AGENTIC_CHAT_E2E_CALLS__?: number;
        __AGENTIC_CHAT_E2E_CALL_LOG__?: unknown[];
      };
      delete target.__AGENTIC_CHAT_E2E_TURNS__;
      delete target.__AGENTIC_CHAT_E2E_CALLS__;
      delete target.__AGENTIC_CHAT_E2E_CALL_LOG__;
    });
  });
});
