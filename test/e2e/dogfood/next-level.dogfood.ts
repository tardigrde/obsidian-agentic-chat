import { browser, expect, $ } from "@wdio/globals";
import { after, before, describe, it } from "mocha";
import {
  assertDogfoodInvariants,
  loadDogfoodManifest,
  writeDogfoodRunReport,
  type DogfoodManifest,
} from "../../../scripts/dogfood-core";

const TURN_TIMEOUT_MS = Number(process.env.DOGFOOD_TURN_TIMEOUT_MS || 120_000);
const MANIFEST_PATH = process.env.DOGFOOD_FIXTURE_MANIFEST?.trim() ?? "";
const PLUGIN_ID = "agentic-chat";
const CLOSED_APPROVAL_PATH = "Generated/Closed Approval Should Not Exist.md";
const DOUBLE_CLICK_APPROVAL_PATH = "Generated/Double Click Approval.md";
const SETTINGS_RACE_ALLOWED_PATH = "Generated/Settings Race Allowed.md";
const SETTINGS_RACE_DENIED_PATH = "Generated/Settings Race Denied Should Not Exist.md";
const BATCH_FIRST_DENIED_PATH = "Generated/Batch First Should Not Exist.md";
const BATCH_SECOND_ALLOWED_PATH = "Generated/Batch Second.md";
const NEW_SESSION_CONTINUATION_PATH = "Generated/New Session Continuation.md";
const EMPTY_FOLDER_DELETE_PATH = "Generated/Empty Folder Delete";

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

function scriptedTurns(): ScriptedTurn[] {
  return [
    toolBatch("oracle matrix", [
      { id: "o-list-root", name: "vault_inspect", args: { action: "list", path: "" } },
      { id: "o-search", name: "vault_inspect", args: { action: "search", query: "OAuth", kind: "content", path: "Messy", maxMatches: 5 } },
      { id: "o-active", name: "vault_inspect", args: { action: "active_note", includeContent: true } },
      { id: "o-props", name: "vault_inspect", args: { action: "properties", path: "Messy/Home.md" } },
      { id: "o-read", name: "read", args: { path: "Odd Files/Invalid Frontmatter.md" } },
      { id: "o-read-range", name: "read", args: { path: "Odd Files/Invalid Frontmatter.md", startLine: 1, endLine: 3 } },
      { id: "o-memory", name: "search_memory", args: { query: "DevOps knowledge-base", scope: "vault", maxResults: 3 } },
      { id: "o-ext-list", name: "external_inspect", args: { action: "list", path: "repos" } },
      { id: "o-ext-read", name: "external_inspect", args: { action: "read", path: "foreign-vault/Imported.md" } },
      { id: "o-ext-read-range", name: "external_inspect", args: { action: "read", path: "foreign-vault/Imported.md", startLine: 1, endLine: 2 } },
      { id: "o-ext-search", name: "external_inspect", args: { action: "search", path: "repos", query: "service-a", kind: "content", maxMatches: 5 } },
      {
        id: "o-write",
        name: "write",
        args: {
          path: "Generated/Oracle.md",
          content: [
            "---",
            "tags: [dogfood, oracle]",
            "source: external://foreign-vault/Imported.md",
            "---",
            "# Oracle",
            "Initial oracle body.",
            "See [[Generated/Oracle Companion]] and [[Messy/Target]].",
            "",
          ].join("\n"),
        },
      },
      {
        id: "o-write-companion",
        name: "write",
        args: {
          path: "Generated/Oracle Companion.md",
          content: "---\ntags: [dogfood, oracle]\n---\n# Oracle Companion\nSupports the oracle note.\n",
        },
      },
      {
        id: "o-write-rename-source",
        name: "write",
        args: {
          path: "Generated/Rename Source.md",
          content: "---\ntags: [dogfood, rename]\n---\n# Rename Source\nThis note should move.\n",
        },
      },
      { id: "o-set-props", name: "set_properties", args: { path: "Generated/Oracle.md", properties: { verified: true } } },
      { id: "o-rename", name: "rename", args: { path: "Generated/Rename Source.md", newPath: "Generated/Renamed.md" } },
      { id: "o-delete", name: "delete", args: { path: "Generated/Delete Me.md" } },
      { id: "o-delete-empty-folder", name: "delete", args: { path: EMPTY_FOLDER_DELETE_PATH } },
    ]),
    textTurn("oracle final", "Oracle matrix complete."),
    toolBatch("restricted active note", [
      { id: "r-active", name: "vault_inspect", args: { action: "active_note", includeContent: true } },
    ]),
    textTurn("restricted final", "Restricted active note stayed hidden."),
    toolBatch("metamorphic clarify", [
      {
        id: "m-ask",
        name: "ask_user",
        args: { question: "What should be cleaned up?", choices: ["Only generated stale notes", "Cancel cleanup"] },
      },
    ]),
    textTurn("metamorphic final", "Ambiguous cleanup was clarified and stayed scoped."),
    toolBatch("cache replay", [
      { id: "cache-read", name: "external_inspect", args: { action: "read", path: "foreign-vault/Imported.md" } },
    ]),
    textTurn("cache final", "External cache replay complete."),
    toolBatch("chaos denied tools", [
      { id: "c-ext-deny", name: "external_inspect", args: { action: "read", path: "foreign-vault/Imported.md" } },
      { id: "c-write-deny", name: "write", args: { path: "Generated/Denied Should Not Exist.md", content: "denied" } },
    ]),
    textTurn("chaos final", "Chaos settings denied risky tools cleanly."),
    toolBatch("post reload refine", [
      { id: "p-read", name: "read", args: { path: "Generated/Oracle.md" } },
      {
        id: "p-edit",
        name: "edit",
        args: {
          path: "Generated/Oracle.md",
          edits: [{ oldText: "Initial oracle body.", newText: "Initial oracle body refined after plugin reload." }],
        },
      },
      {
        id: "p-write-reload",
        name: "write",
        args: {
          path: "Generated/Reload Continuation.md",
          content: "---\ntags: [dogfood, reload]\n---\n# Reload Continuation\nContinued after plugin reload.\n",
        },
      },
      { id: "p-graph", name: "vault_inspect", args: { action: "local_graph", path: "Generated/Oracle.md" } },
    ]),
    textTurn("post reload final", "Post-reload refinement complete."),
    toolBatch("undo candidate", [
      {
        id: "u-write",
        name: "write",
        args: {
          path: "Generated/Undo Candidate.md",
          content: "---\ntags: [dogfood, undo]\n---\n# Undo Candidate\nThis note should be removed by slash undo.\n",
        },
      },
    ]),
    textTurn("undo final", "Undo candidate created."),
    toolBatch("closed approval write", [
      {
        id: "a-close-write",
        name: "write",
        args: {
          path: CLOSED_APPROVAL_PATH,
          content: "# Closed Approval\n\nThis note should not be created when the modal is dismissed.\n",
        },
      },
    ]),
    textTurn("closed approval final", "Closed approval denied safely."),
    toolBatch("double-click approval write", [
      {
        id: "a-double-write",
        name: "write",
        args: {
          path: DOUBLE_CLICK_APPROVAL_PATH,
          content: "---\ntags: [dogfood, approval]\n---\n# Double Click Approval\nApproved once despite a double click.\n",
        },
      },
    ]),
    textTurn("double-click approval final", "Double-click approval applied once."),
    toolBatch("settings race open approval", [
      {
        id: "a-settings-race-allow",
        name: "write",
        args: {
          path: SETTINGS_RACE_ALLOWED_PATH,
          content: "---\ntags: [dogfood, approval]\n---\n# Settings Race Allowed\nThe in-flight modal decision won.\n",
        },
      },
    ]),
    textTurn("settings race open final", "In-flight approval was isolated from the settings change."),
    toolBatch("settings race follow-up denied", [
      {
        id: "a-settings-race-deny",
        name: "write",
        args: {
          path: SETTINGS_RACE_DENIED_PATH,
          content: "# Settings Race Denied\n\nThis should not be created after write is denied.\n",
        },
      },
    ]),
    textTurn("settings race follow-up final", "Follow-up write honored the changed setting."),
    toolBatch("batch approval queue", [
      {
        id: "a-batch-deny",
        name: "write",
        args: {
          path: BATCH_FIRST_DENIED_PATH,
          content: "# Batch First\n\nThis first batch mutation should be denied.\n",
        },
      },
      {
        id: "a-batch-allow",
        name: "write",
        args: {
          path: BATCH_SECOND_ALLOWED_PATH,
          content: "---\ntags: [dogfood, approval]\n---\n# Batch Second\nThe second batch mutation still asked before running.\n",
        },
      },
    ]),
    textTurn("batch approval final", "Batch approval decisions stayed independent."),
    toolBatch("ask denial", [
      {
        id: "a-ask-denial",
        name: "ask_user",
        args: { question: "Should cleanup continue?", choices: ["Proceed", "Cancel cleanup"] },
      },
    ]),
    textTurn("ask denial final", "Cleanup cancelled after the denial answer."),
    toolBatch("ask irrelevant late", [
      {
        id: "a-ask-irrelevant",
        name: "ask_user",
        args: { question: "Which output should be refined?", choices: ["Repo profiles", "Tech map"] },
      },
    ]),
    textTurn("ask irrelevant late final", "Irrelevant late answer was preserved for follow-up."),
    toolBatch("new session continuation", [
      {
        id: "s-new-session-write",
        name: "write",
        args: {
          path: NEW_SESSION_CONTINUATION_PATH,
          content: "---\ntags: [dogfood, sessions]\n---\n# New Session Continuation\nScripted replay continued after /new.\n",
        },
      },
    ]),
    textTurn("new session continuation final", "New session continuation complete."),
  ];
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

async function configurePlugin(manifest: DogfoodManifest): Promise<boolean> {
  return await browser.executeObsidian(async ({ app }, payload) => {
    const plugin = (app as unknown as {
      plugins?: { plugins?: Record<string, SettingsPlugin> };
    }).plugins?.plugins?.[payload.pluginId];
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
    settings.openrouterApiKey = "e2e-next-level-scripted-key";
    settings.mode = "safe";
    settings.enableBuiltinAgents = false;
    settings.ignoredGlobs = payload.ignoredGlobs.join("\n");
    settings.approval.mutating = "allow";
    settings.approval.perTool = {};
    settings.approval.workingDirs = [];
    settings.external.enabled = true;
    settings.external.rootPath = payload.externalRoot;
    settings.external.approval = "allow";
    settings.external.honorGitignore = true;
    settings.external.ignoredGlobs = [".env", ".env.*", "*.key", "*.pem", "secrets/**"].join("\n");
    settings.toolBudget.enabled = false;
    settings.toolBudget.thresholdPercent = 25;
    settings.web.enabled = false;
    settings.mcp = { enabled: false, proxyUrl: "", noProxy: "localhost,127.0.0.1,::1", servers: [] };
    await plugin.saveSettings?.();
    return true;
  }, { pluginId: PLUGIN_ID, ignoredGlobs: manifest.ignoredGlobs, externalRoot: manifest.externalRoot });
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

async function setWriteApproval(policy: "allow" | "ask" | "deny" | null): Promise<void> {
  await browser.executeObsidian(async ({ app }, nextPolicy) => {
    const plugin = (app as unknown as {
      plugins?: { plugins?: Record<string, SettingsPlugin> };
    }).plugins?.plugins?.["agentic-chat"];
    if (!plugin?.settings) throw new Error("agentic-chat plugin not found");
    const settings = plugin.settings as {
      approval: { perTool: Record<string, string> };
    };
    settings.approval.perTool = { ...settings.approval.perTool };
    if (nextPolicy === null) delete settings.approval.perTool.write;
    else settings.approval.perTool.write = nextPolicy;
    await plugin.saveSettings?.();
  }, policy);
}

async function restoreSafeSettings(): Promise<void> {
  await browser.executeObsidian(async ({ app }) => {
    const plugin = (app as unknown as {
      plugins?: { plugins?: Record<string, SettingsPlugin> };
    }).plugins?.plugins?.["agentic-chat"];
    if (!plugin?.settings) return;
    const settings = plugin.settings as {
      approval: { mutating: string; perTool: Record<string, string> };
      external: { approval: string };
      toolBudget: { enabled: boolean; thresholdPercent: number };
    };
    settings.approval.mutating = "allow";
    settings.approval.perTool = {};
    settings.external.approval = "allow";
    settings.toolBudget.enabled = false;
    settings.toolBudget.thresholdPercent = 25;
    await plugin.saveSettings?.();
  });
}

async function reloadPlugin(): Promise<void> {
  await browser.executeObsidian(async ({ app }) => {
    const pluginApi = (app as unknown as {
      plugins?: {
        disablePluginAndSave?: (id: string) => Promise<void>;
        enablePluginAndSave?: (id: string) => Promise<void>;
      };
    }).plugins;
    if (!pluginApi?.disablePluginAndSave || !pluginApi.enablePluginAndSave) {
      throw new Error("Obsidian plugin API not available");
    }
    await pluginApi.disablePluginAndSave("agentic-chat");
    await pluginApi.enablePluginAndSave("agentic-chat");
  });
  await openChat();
}

async function openChat(): Promise<void> {
  await browser.executeObsidianCommand("agentic-chat:open-chat");
  await $(".agentic-chat-view").waitForExist();
}

async function openNote(path: string): Promise<void> {
  await browser.executeObsidian(async ({ app, obsidian }, notePath) => {
    const file = app.vault.getAbstractFileByPath(notePath);
    if (!(file instanceof obsidian.TFile)) throw new Error(`note missing: ${notePath}`);
    await app.workspace.getLeaf(false).openFile(file);
  }, path);
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

async function runPrompt(prompt: string): Promise<void> {
  await sendPrompt(prompt);
  await waitForTurnToFinish();
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

async function waitForApprovalModal() {
  const modal = await $(".agentic-chat-approval");
  await modal.waitForExist({ timeout: 10_000 });
  return modal;
}

async function allowApproval(): Promise<void> {
  const modal = await waitForApprovalModal();
  const allow = await modal.$("button=Allow");
  await allow.waitForExist({ timeout: 5_000 });
  await allow.click();
  await modal.waitForExist({ reverse: true, timeout: 5_000 });
}

async function denyApprovalAndWaitForNextTarget(path: string): Promise<void> {
  const modal = await waitForApprovalModal();
  const deny = await modal.$("button=Deny");
  await deny.waitForExist({ timeout: 5_000 });
  await deny.click();
  await browser.waitUntil(
    async () => {
      const next = await $(".agentic-chat-approval");
      if (!(await next.isExisting().catch(() => false))) return false;
      return (await next.getText()).includes(path);
    },
    { timeout: 10_000, timeoutMsg: `next queued approval did not target ${path}` },
  );
}

async function closeApprovalWithEscape(): Promise<void> {
  const modal = await waitForApprovalModal();
  await browser.keys("Escape");
  await modal.waitForExist({ reverse: true, timeout: 5_000 });
}

async function doubleClickAllowApproval(): Promise<void> {
  const modal = await waitForApprovalModal();
  await browser.execute(() => {
    const root = document.querySelector<HTMLElement>(".agentic-chat-approval");
    const allow = Array.from(root?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
      (button) => button.innerText.trim() === "Allow",
    );
    if (!allow) throw new Error("approval Allow button not mounted");
    allow.click();
    allow.click();
  });
  await modal.waitForExist({ reverse: true, timeout: 5_000 });
}

async function loadFirstInactiveSessionFromList(): Promise<void> {
  await sendPrompt("/sessions");
  const modal = await $(".agentic-chat-session-list");
  await modal.waitForExist({ timeout: 10_000 });
  const loaded = await browser.execute(() => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>(".agentic-chat-session-row"));
    const target = rows.find((row) => !row.classList.contains("is-active"));
    target?.querySelector<HTMLElement>(".agentic-chat-session-main")?.click();
    return !!target;
  });
  expect(loaded).toBe(true);
  await modal.waitForExist({ reverse: true, timeout: 5_000 });
}

async function waitForTurnToFinish(): Promise<void> {
  await browser.waitUntil(
    async () => {
      const stopVisible = await $(".agentic-chat-stop").isDisplayed().catch(() => false);
      const approvalOpen = await $(".agentic-chat-approval").isExisting().catch(() => false);
      const askUserOpen = await $(".agentic-chat-ask-user").isExisting().catch(() => false);
      return !stopVisible && !approvalOpen && !askUserOpen;
    },
    { timeout: TURN_TIMEOUT_MS, timeoutMsg: "next-level dogfood turn did not finish" },
  );
}

async function transcriptText(): Promise<string> {
  return await browser.execute(() => document.querySelector<HTMLElement>(".agentic-chat-messages")?.innerText ?? "");
}

async function latestSessionText(): Promise<string> {
  return await browser.executeObsidian(async ({ app }) => {
    const sessionDir = `${app.vault.configDir}/plugins/agentic-chat/sessions`;
    const listing = await app.vault.adapter.list(sessionDir);
    const latest = listing.files.filter((file) => file.endsWith(".jsonl")).sort().at(-1);
    return latest ? await app.vault.adapter.read(latest) : "";
  });
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

async function scriptedCallLabels(): Promise<string[]> {
  return await browser.execute(() => {
    const target = window as typeof window & {
      __AGENTIC_CHAT_E2E_CALL_LOG__?: Array<{ label?: string }>;
    };
    return target.__AGENTIC_CHAT_E2E_CALL_LOG__?.map((call) => call.label ?? "") ?? [];
  });
}

describe("agentic-chat next-level dogfood", function () {
  let manifest: DogfoodManifest;

  before(async function () {
    if (!MANIFEST_PATH) this.skip();
    manifest = await loadDogfoodManifest(MANIFEST_PATH);
    await installScriptedTurns(scriptedTurns());
    const configured = await configurePlugin(manifest);
    if (!configured) throw new Error("agentic-chat plugin not found in the next-level dogfood vault");
    await openNote(manifest.expectedActiveNote);
    await openChat();
  });

  it("runs an oracle matrix over the generated adversarial vault", async function () {
    await browser.executeObsidian(async ({ app }) => {
      if (!app.vault.getAbstractFileByPath("Generated")) await app.vault.createFolder("Generated");
      if (!app.vault.getAbstractFileByPath("Generated/Empty Folder Delete")) {
        await app.vault.createFolder("Generated/Empty Folder Delete");
      }
    });
    await runPrompt("Inspect this adversarial dogfood vault, build the oracle notes, and exercise the default tool matrix.");

    expect(await noteExists("Generated/Oracle.md")).toBe(true);
    expect(await noteExists("Generated/Oracle Companion.md")).toBe(true);
    expect(await noteExists("Generated/Renamed.md")).toBe(true);
    expect(await noteExists("Generated/Delete Me.md")).toBe(false);
    expect(await noteExists(EMPTY_FOLDER_DELETE_PATH)).toBe(false);
    const oracle = await readNote("Generated/Oracle.md");
    expect(oracle).toContain("source: external://foreign-vault/Imported.md");
    expect(oracle).toContain("verified: true");
  });

  it("keeps restricted active notes hidden", async function () {
    await openNote("Restricted/Secret.secret.md");
    await runPrompt("Inspect the active note only if it is allowed.");

    const raw = await latestSessionText();
    expect(raw).not.toContain(manifest.secretText);
    expect(raw).toContain("No active Markdown note.");
    await openNote(manifest.expectedActiveNote);
  });

  it("routes metamorphic unclear cleanup through ask_user", async function () {
    await sendPrompt("Clean this up. Remove the bad ones and tidy this folder.");
    await answerAskUser("Only generated stale notes; do not delete anything else.");
    await waitForTurnToFinish();

    expect(await transcriptText()).toContain("Ambiguous cleanup was clarified");
  });

  it("observes a repeated external read as a cache hit", async function () {
    await runPrompt("Read the same imported external note again and report whether it is cached.");

    expect(await latestSessionText()).toContain('"cached":true');
  });

  it("applies chaos settings, denies risky tools, and restores defaults", async function () {
    await setChaosSettings();
    const diagnostics = await runSlashCommand("/diagnostics");
    expect(diagnostics).toContain("Tool budget");
    expect(diagnostics).toContain("active");

    await runPrompt("Try an external read and write while settings deny them.");
    expect(await noteExists("Generated/Denied Should Not Exist.md")).toBe(false);
    await restoreSafeSettings();
  });

  it("survives plugin reload and continues the workflow", async function () {
    await reloadPlugin();
    await openNote(manifest.expectedActiveNote);
    await runPrompt("Continue after plugin reload by refining the oracle and writing the reload continuation note.");

    expect(await readNote("Generated/Oracle.md")).toContain("refined after plugin reload");
    expect(await readNote("Generated/Reload Continuation.md")).toContain("plugin reload");
  });

  it("keeps undo coherent after post-reload writes", async function () {
    await runPrompt("Create the undo candidate note.");
    expect(await noteExists("Generated/Undo Candidate.md")).toBe(true);
    await runSlashCommand("/undo");
    await browser.waitUntil(async () => !(await noteExists("Generated/Undo Candidate.md")), {
      timeout: 10_000,
      timeoutMsg: "slash undo did not remove the undo candidate",
    });
  });

  it("denies safely when an approval modal is dismissed", async function () {
    try {
      await setWriteApproval("ask");
      await sendPrompt("Attempt a write, then dismiss the approval modal.");
      await closeApprovalWithEscape();
      await waitForTurnToFinish();

      expect(await noteExists(CLOSED_APPROVAL_PATH)).toBe(false);
      expect(await transcriptText()).toContain("Closed approval denied safely");
    } finally {
      await restoreSafeSettings();
    }
  });

  it("handles a double-clicked approval without duplicating the mutation", async function () {
    try {
      await setWriteApproval("ask");
      await sendPrompt("Create the double-click approval note.");
      await doubleClickAllowApproval();
      await waitForTurnToFinish();

      expect(await noteExists(DOUBLE_CLICK_APPROVAL_PATH)).toBe(true);
      expect(await readNote(DOUBLE_CLICK_APPROVAL_PATH)).toContain("Approved once despite a double click.");
    } finally {
      await restoreSafeSettings();
    }
  });

  it("keeps in-flight approval decisions separate from changed settings", async function () {
    try {
      await setWriteApproval("ask");
      await sendPrompt("Open an approval, change write approval to deny, then allow the in-flight write.");
      await waitForApprovalModal();
      await setWriteApproval("deny");
      await allowApproval();
      await waitForTurnToFinish();

      expect(await noteExists(SETTINGS_RACE_ALLOWED_PATH)).toBe(true);

      await runPrompt("Try a follow-up write after write approval is denied.");
      expect(await noteExists(SETTINGS_RACE_DENIED_PATH)).toBe(false);
    } finally {
      await restoreSafeSettings();
    }
  });

  it("keeps queued batch approvals independent", async function () {
    try {
      await setWriteApproval("ask");
      await sendPrompt("Run a two-write batch; deny the first and allow the second.");
      await denyApprovalAndWaitForNextTarget(BATCH_SECOND_ALLOWED_PATH);
      await allowApproval();
      await waitForTurnToFinish();

      expect(await noteExists(BATCH_FIRST_DENIED_PATH)).toBe(false);
      expect(await noteExists(BATCH_SECOND_ALLOWED_PATH)).toBe(true);
    } finally {
      await restoreSafeSettings();
    }
  });

  it("handles ask_user denial and late irrelevant answers", async function () {
    await sendPrompt("Ask whether cleanup should continue.");
    await answerAskUser("Cancel cleanup");
    await waitForTurnToFinish();
    expect(await transcriptText()).toContain("Cleanup cancelled after the denial answer");

    await sendPrompt("Ask which output should be refined, then receive an irrelevant answer.");
    await browser.pause(500);
    await answerAskUser("The answer is unrelated; do not infer a target.");
    await waitForTurnToFinish();
    expect(await transcriptText()).toContain("Irrelevant late answer was preserved");
  });

  it("continues after /new and can switch back to the prior session", async function () {
    await runSlashCommand("/new");
    await runPrompt("Continue the replay in a fresh session.");

    expect(await noteExists(NEW_SESSION_CONTINUATION_PATH)).toBe(true);
    await loadFirstInactiveSessionFromList();
    expect(await transcriptText()).toContain("Post-reload refinement complete");
  });

  it("passes the dogfood invariant oracle and writes a report", async function () {
    expect(await scriptedCallLabels()).toEqual([
      "oracle matrix",
      "oracle final",
      "restricted active note",
      "restricted final",
      "metamorphic clarify",
      "metamorphic final",
      "cache replay",
      "cache final",
      "chaos denied tools",
      "chaos final",
      "post reload refine",
      "post reload final",
      "undo candidate",
      "undo final",
      "closed approval write",
      "closed approval final",
      "double-click approval write",
      "double-click approval final",
      "settings race open approval",
      "settings race open final",
      "settings race follow-up denied",
      "settings race follow-up final",
      "batch approval queue",
      "batch approval final",
      "ask denial",
      "ask denial final",
      "ask irrelevant late",
      "ask irrelevant late final",
      "new session continuation",
      "new session continuation final",
    ]);
    const result = await assertDogfoodInvariants(manifest);
    const reportPath = await writeDogfoodRunReport(result);
    expect(reportPath).toContain(`${manifest.runId}-summary.md`);
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
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
