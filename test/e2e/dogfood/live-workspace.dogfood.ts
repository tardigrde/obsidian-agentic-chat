import { readFileSync } from "node:fs";
import { browser, expect, $ } from "@wdio/globals";
import { before, describe, it } from "mocha";
import {
  assertDogfoodInvariants,
  writeDogfoodRunReport,
  type DogfoodManifest,
} from "../../../scripts/dogfood-core";

const DEFAULT_NOTE_DIR = "Agentic Chat Dogfood";
const TURN_TIMEOUT_MS = Number(process.env.DOGFOOD_TURN_TIMEOUT_MS || 8 * 60 * 1000);

type RepoTarget = {
  index: number;
  repoPath: string;
  notePath: string;
  label: string;
};

const DEFAULT_REPO_TARGETS: RepoTarget[] = [
  {
    index: 1,
    repoPath: "repos/service-a",
    notePath: "01 Repositories/01 service-a.md",
    label: "service-a",
  },
  {
    index: 2,
    repoPath: "repos/service-b",
    notePath: "01 Repositories/02 service-b.md",
    label: "service-b",
  },
];

const REPO_TARGETS: RepoTarget[] = readRepoTargets();

type SettingsPlugin = {
  settings?: Record<string, unknown>;
  saveSettings?: () => Promise<void>;
};

type ApprovalDecision = {
  title: string;
  action: "allow" | "deny" | "answer";
};

type ApprovalPumpOptions = {
  allowExactPaths?: string[];
  askUserAnswer?: string | ((question: string) => string);
  denyMutationTitleIncludes?: string[];
};

const AGENTS_BASELINE = "When creating a new note, use the set_properties and add a frontmatter too.";
const DEFAULT_ASK_USER_ANSWER =
  "No. Continue only within the already approved dogfood scope, and do not broaden permissions or modify top-level vault files.";

function readRepoTargets(): RepoTarget[] {
  const raw = process.env.DOGFOOD_REPO_TARGETS_JSON?.trim();
  if (!raw) return DEFAULT_REPO_TARGETS;
  const parsed = JSON.parse(raw) as Array<string | Partial<RepoTarget>>;
  return parsed.map((entry, index) => normalizeRepoTarget(entry, index + 1));
}

function normalizeRepoTarget(entry: string | Partial<RepoTarget>, index: number): RepoTarget {
  const repoPath = typeof entry === "string" ? entry : entry.repoPath;
  if (!repoPath?.trim()) throw new Error(`DOGFOOD_REPO_TARGETS_JSON entry ${index} is missing repoPath.`);
  const label = typeof entry === "string" ? repoPath.replace(/^repos\//, "") : entry.label?.trim() || repoPath.replace(/^repos\//, "");
  return {
    index,
    repoPath,
    label,
    notePath:
      typeof entry === "string" || !entry.notePath?.trim()
        ? `01 Repositories/${String(index).padStart(2, "0")} ${slugify(label)}.md`
        : entry.notePath,
  };
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "repo";
}

function chunkRepoTargets(targets: RepoTarget[], size: number): RepoTarget[][] {
  const chunks: RepoTarget[][] = [];
  for (let index = 0; index < targets.length; index += size) {
    chunks.push(targets.slice(index, index + size));
  }
  return chunks;
}

type ApprovalSnapshot = {
  mutating: string;
  perTool: Record<string, string>;
  workingDirs: string[];
};

type ToggleSettingsSnapshot = {
  external: {
    enabled: boolean;
    rootPath: string;
    approval: "allow" | "ask" | "deny";
    honorGitignore: boolean;
    ignoredGlobs: string;
  };
  toolBudget: {
    enabled: boolean;
    thresholdPercent: number;
  };
};

type ModelSettingsSnapshot = {
  openaiCompatibleModel: string;
};

type McpSettingsSnapshot = {
  enabled: boolean;
  proxyUrl: string;
  noProxy: string;
  servers: unknown[];
};

function readApiKey(): string | undefined {
  const inline = optionalEnv("AGENTIC_CHAT_API_KEY", "AGENTIC_CHAT_LIVE_API_KEY", "OPENWEBUI_API_KEY");
  if (inline) return inline;

  const file = optionalEnv("AGENTIC_CHAT_API_KEY_FILE", "AGENTIC_CHAT_LIVE_API_KEY_FILE", "OPENWEBUI_API_KEY_FILE");
  if (!file) return undefined;
  const value = readFileSync(file, "utf8").trim();
  return value || undefined;
}

function optionalEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
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
  const before = await browser.execute(() => document.querySelector<HTMLElement>(".agentic-chat-messages")?.innerText ?? "");
  await sendPrompt(command);
  await browser.waitUntil(
    async () => {
      const after = await browser.execute(() => document.querySelector<HTMLElement>(".agentic-chat-messages")?.innerText ?? "");
      return after !== before;
    },
    { timeout: 10_000, timeoutMsg: `slash command ${command} did not update the transcript` },
  );
  return await browser.execute(() => {
    return document.querySelector<HTMLElement>(".agentic-chat-messages")?.innerText ?? "";
  });
}

async function runSlashCommandDelta(command: string): Promise<string> {
  const before = await browser.execute(() => document.querySelector<HTMLElement>(".agentic-chat-messages")?.innerText ?? "");
  const after = await runSlashCommand(command);
  return after.slice(before.length);
}

async function configureDogfoodSettings(config: {
  apiKey: string;
  baseUrl: string;
  model: string;
  externalRoot: string;
}): Promise<boolean> {
  return await browser.executeObsidian(async ({ app }, liveConfig) => {
    const plugin = (app as unknown as {
      plugins?: { plugins?: Record<string, SettingsPlugin> };
    }).plugins?.plugins?.["agentic-chat"];
    if (!plugin?.settings) return false;
    const settings = plugin.settings as {
      provider: string;
      openaiCompatibleApiKey: string;
      openaiCompatibleBaseUrl: string;
      openaiCompatibleModel: string;
      requestTimeoutMs: number;
      maxNetworkRetries: number;
      mode: string;
      approval: { mutating: string; perTool: Record<string, string>; workingDirs: string[] };
      network: { proxyUrl: string; noProxy: string };
      external: {
        enabled: boolean;
        rootPath: string;
        approval: string;
        honorGitignore: boolean;
        ignoredGlobs: string;
      };
    };

    settings.provider = "openai-compatible";
    settings.openaiCompatibleApiKey = liveConfig.apiKey;
    settings.openaiCompatibleBaseUrl = liveConfig.baseUrl;
    settings.openaiCompatibleModel = liveConfig.model;
    settings.requestTimeoutMs = 180_000;
    settings.maxNetworkRetries = 2;
    settings.mode = "safe";
    settings.approval.mutating = "ask";
    settings.approval.perTool = { read: "allow", vault_inspect: "allow" };
    settings.approval.workingDirs = [];
    settings.network.proxyUrl = process.env.AGENTIC_CHAT_E2E_PROXY_SERVER || settings.network.proxyUrl;
    settings.network.noProxy = "localhost,127.0.0.1,::1";
    settings.external.enabled = true;
    settings.external.rootPath = liveConfig.externalRoot;
    settings.external.approval = "ask";
    settings.external.honorGitignore = true;
    settings.external.ignoredGlobs = [".env", ".env.*", "*.pem", "*.key", ".ssh/"].join("\n");
    await plugin.saveSettings?.();
    return true;
  }, config);
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

async function activeFilePath(): Promise<string | null> {
  return await browser.executeObsidian(async ({ app }) => app.workspace.getActiveFile()?.path ?? null);
}

async function getApprovalSnapshot(): Promise<ApprovalSnapshot> {
  return await browser.executeObsidian(async ({ app }) => {
    const plugin = (app as unknown as {
      plugins?: { plugins?: Record<string, SettingsPlugin> };
    }).plugins?.plugins?.["agentic-chat"];
    if (!plugin?.settings) throw new Error("agentic-chat plugin not found");
    const settings = plugin.settings as {
      approval: { mutating: string; perTool: Record<string, string>; workingDirs: string[] };
    };
    return {
      mutating: settings.approval.mutating,
      perTool: { ...settings.approval.perTool },
      workingDirs: [...settings.approval.workingDirs],
    };
  });
}

async function setApprovalSnapshot(snapshot: ApprovalSnapshot): Promise<void> {
  await browser.executeObsidian(async ({ app }, next) => {
    const plugin = (app as unknown as {
      plugins?: { plugins?: Record<string, SettingsPlugin> };
    }).plugins?.plugins?.["agentic-chat"];
    if (!plugin?.settings) throw new Error("agentic-chat plugin not found");
    const settings = plugin.settings as {
      approval: { mutating: string; perTool: Record<string, string>; workingDirs: string[] };
    };
    settings.approval.mutating = next.mutating;
    settings.approval.perTool = { ...next.perTool };
    settings.approval.workingDirs = [...next.workingDirs];
    await plugin.saveSettings?.();
  }, snapshot);
}

async function getToggleSettingsSnapshot(): Promise<ToggleSettingsSnapshot> {
  return await browser.executeObsidian(async ({ app }) => {
    const plugin = (app as unknown as {
      plugins?: { plugins?: Record<string, SettingsPlugin> };
    }).plugins?.plugins?.["agentic-chat"];
    if (!plugin?.settings) throw new Error("agentic-chat plugin not found");
    const settings = plugin.settings as ToggleSettingsSnapshot;
    return {
      external: { ...settings.external },
      toolBudget: { ...settings.toolBudget },
    };
  });
}

async function setToggleSettingsSnapshot(snapshot: ToggleSettingsSnapshot): Promise<void> {
  await browser.executeObsidian(async ({ app }, next) => {
    const plugin = (app as unknown as {
      plugins?: { plugins?: Record<string, SettingsPlugin> };
    }).plugins?.plugins?.["agentic-chat"];
    if (!plugin?.settings) throw new Error("agentic-chat plugin not found");
    const settings = plugin.settings as ToggleSettingsSnapshot;
    settings.external = { ...next.external };
    settings.toolBudget = { ...next.toolBudget };
    await plugin.saveSettings?.();
  }, snapshot);
}

async function getModelSettingsSnapshot(): Promise<ModelSettingsSnapshot> {
  return await browser.executeObsidian(async ({ app }) => {
    const plugin = (app as unknown as {
      plugins?: { plugins?: Record<string, SettingsPlugin> };
    }).plugins?.plugins?.["agentic-chat"];
    if (!plugin?.settings) throw new Error("agentic-chat plugin not found");
    const settings = plugin.settings as ModelSettingsSnapshot;
    return { openaiCompatibleModel: settings.openaiCompatibleModel };
  });
}

async function setModelSettingsSnapshot(snapshot: ModelSettingsSnapshot): Promise<void> {
  await browser.executeObsidian(async ({ app }, next) => {
    const plugin = (app as unknown as {
      plugins?: { plugins?: Record<string, SettingsPlugin> };
    }).plugins?.plugins?.["agentic-chat"];
    if (!plugin?.settings) throw new Error("agentic-chat plugin not found");
    const settings = plugin.settings as ModelSettingsSnapshot;
    settings.openaiCompatibleModel = next.openaiCompatibleModel;
    await plugin.saveSettings?.();
  }, snapshot);
}

async function getMcpSettingsSnapshot(): Promise<McpSettingsSnapshot> {
  return await browser.executeObsidian(async ({ app }) => {
    const plugin = (app as unknown as {
      plugins?: { plugins?: Record<string, SettingsPlugin> };
    }).plugins?.plugins?.["agentic-chat"];
    if (!plugin?.settings) throw new Error("agentic-chat plugin not found");
    const settings = plugin.settings as { mcp: McpSettingsSnapshot };
    return {
      enabled: settings.mcp.enabled,
      proxyUrl: settings.mcp.proxyUrl,
      noProxy: settings.mcp.noProxy,
      servers: settings.mcp.servers.map((server) => ({ ...(server as Record<string, unknown>) })),
    };
  });
}

async function setMcpSettingsSnapshot(snapshot: McpSettingsSnapshot): Promise<void> {
  await browser.executeObsidian(async ({ app }, next) => {
    const plugin = (app as unknown as {
      plugins?: { plugins?: Record<string, SettingsPlugin> };
    }).plugins?.plugins?.["agentic-chat"];
    if (!plugin?.settings) throw new Error("agentic-chat plugin not found");
    const settings = plugin.settings as { mcp: McpSettingsSnapshot };
    settings.mcp = {
      enabled: next.enabled,
      proxyUrl: next.proxyUrl,
      noProxy: next.noProxy,
      servers: next.servers.map((server) => ({ ...(server as Record<string, unknown>) })),
    };
    await plugin.saveSettings?.();
  }, snapshot);
}

async function startNewConversation(): Promise<void> {
  await browser.executeObsidianCommand("agentic-chat:new-conversation");
  await browser.waitUntil(
    async () => {
      const text = await browser.execute(() => document.querySelector<HTMLElement>(".agentic-chat-messages")?.innerText ?? "");
      return !text.includes("Session —");
    },
    { timeout: 5_000, timeoutMsg: "new conversation did not clear the visible transcript" },
  );
}

async function openDogfoodScratch(noteDir: string): Promise<void> {
  await browser.executeObsidian(async ({ app, obsidian }, dir) => {
    if (!app.vault.getAbstractFileByPath(dir)) await app.vault.createFolder(dir);
    const path = `${dir}/Dogfood Scratch.md`;
    const body = "# Dogfood Scratch\n\nTemporary active note for live harness runs.\n";
    const existing = app.vault.getAbstractFileByPath(path);
    const file = existing instanceof obsidian.TFile ? existing : await app.vault.create(path, body);
    if (existing instanceof obsidian.TFile) await app.vault.modify(existing, body);
    await app.workspace.getLeaf(false).openFile(file);
  }, noteDir);
}

async function latestSessionLineCount(): Promise<number> {
  return await browser.executeObsidian(async ({ app }) => {
    const sessionDir = `${app.vault.configDir}/plugins/agentic-chat/sessions`;
    const listing = await app.vault.adapter.list(sessionDir);
    const latest = listing.files.filter((path) => path.endsWith(".jsonl")).sort().at(-1);
    if (!latest) return 0;
    const raw = await app.vault.adapter.read(latest);
    return raw.split("\n").filter((line) => line.trim()).length;
  });
}

async function latestSessionText(): Promise<string> {
  return await browser.executeObsidian(async ({ app }) => {
    const sessionDir = `${app.vault.configDir}/plugins/agentic-chat/sessions`;
    const listing = await app.vault.adapter.list(sessionDir);
    const latest = listing.files.filter((path) => path.endsWith(".jsonl")).sort().at(-1);
    if (!latest) return "";
    return await app.vault.adapter.read(latest);
  });
}

async function latestApprovalDecisionCount(toolName: string, decision: string): Promise<number> {
  return await browser.executeObsidian(async ({ app }, expected) => {
    const sessionDir = `${app.vault.configDir}/plugins/agentic-chat/sessions`;
    const listing = await app.vault.adapter.list(sessionDir);
    const latest = listing.files.filter((path) => path.endsWith(".jsonl")).sort().at(-1);
    if (!latest) return 0;
    const raw = await app.vault.adapter.read(latest);
    return raw
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as { type?: string; event?: { category?: string; toolName?: string; decision?: string } })
      .filter(
        (entry) =>
          entry.type === "action_audit" &&
          entry.event?.category === "approval" &&
          entry.event.toolName === expected.toolName &&
          entry.event.decision === expected.decision,
      ).length;
  }, { toolName, decision });
}

async function getSessionCount(): Promise<number> {
  return await browser.executeObsidian(async ({ app }) => {
    const sessionDir = `${app.vault.configDir}/plugins/agentic-chat/sessions`;
    const listing = await app.vault.adapter.list(sessionDir);
    return listing.files.filter((path) => path.endsWith(".jsonl")).length;
  });
}

async function renderedErrorTexts(): Promise<string[]> {
  return await browser.execute(() =>
    Array.from(document.querySelectorAll<HTMLElement>(".agentic-chat-error"))
      .map((element) => element.innerText.trim())
      .filter(Boolean),
  );
}

async function renderedErrors(): Promise<string> {
  return (await renderedErrorTexts()).join("\n");
}

async function renderedErrorCount(): Promise<number> {
  return (await renderedErrorTexts()).length;
}

async function renderedErrorsSince(beforeCount: number): Promise<string> {
  return (await renderedErrorTexts()).slice(beforeCount).join("\n");
}

function startApprovalPump(noteDir: string, decisions: ApprovalDecision[], options: ApprovalPumpOptions = {}): () => void {
  let stopped = false;
  void (async () => {
    while (!stopped) {
      const modal = await $(".agentic-chat-approval");
      if (await modal.isExisting()) {
        const title = await browser.execute(() => document.querySelector<HTMLElement>(".modal-title")?.innerText ?? "");
        const text = await modal.getText();
        const allowExternal = title.includes("Inspect external root");
        const allowDogfoodMutation = isMutationApproval(title) && approvalTargetsPathPrefix(text, `${noteDir}/`);
        const allowExactPathMutation =
          isMutationApproval(title) &&
          (options.allowExactPaths ?? []).some((allowedPath) => approvalTargetsExactPath(text, allowedPath));
        const forcedDeny = (options.denyMutationTitleIncludes ?? []).some((needle) => title.includes(needle));
        const resolvedAction =
          !forcedDeny && (allowExternal || allowDogfoodMutation || allowExactPathMutation) ? "allow" : "deny";
        decisions.push({ title, action: resolvedAction });
        await modal.$(`button=${resolvedAction === "allow" ? "Allow" : "Deny"}`).click();
        await browser.pause(250);
      }
      const askUser = await $(".agentic-chat-ask-user");
      if (await askUser.isExisting()) {
        const question = await askUser.$(".agentic-chat-ask-question").getText();
        const configuredAnswer = options.askUserAnswer ?? DEFAULT_ASK_USER_ANSWER;
        const answer = typeof configuredAnswer === "function" ? configuredAnswer(question) : configuredAnswer;
        decisions.push({ title: `Ask user: ${question}`, action: "answer" });
        await browser.execute(
          (value) => {
            const prompt = document.querySelector<HTMLElement>(".agentic-chat-ask-user");
            const textarea = prompt?.querySelector<HTMLTextAreaElement>(".agentic-chat-ask-input");
            const submit = prompt?.querySelector<HTMLButtonElement>(".agentic-chat-ask-submit");
            if (!textarea || !submit) throw new Error("ask_user prompt controls are not mounted");
            textarea.value = value;
            textarea.dispatchEvent(new Event("input", { bubbles: true }));
            submit.click();
          },
          answer,
        );
        await askUser.waitForExist({ reverse: true, timeout: 10_000 });
      }
      await browser.pause(250);
    }
  })();
  return () => {
    stopped = true;
  };
}

function isMutationApproval(title: string): boolean {
  return (
    title.includes("Write file") ||
    title.includes("Edit file") ||
    title.includes("Delete file") ||
    title.includes("Rename file") ||
    title.includes("Set note properties")
  );
}

function approvalTargetsPathPrefix(text: string, prefix: string): boolean {
  const escapedPrefix = escapeRegExp(prefix);
  return (
    new RegExp(`"path"\\s*:\\s*"${escapedPrefix}`).test(text) ||
    new RegExp(`\\b(?:Writing|Editing|Deleting|Renaming) file:\\s*${escapedPrefix}`).test(text) ||
    new RegExp(`\\b(?:Create|Edit|Move|Rename|Delete)\\s+${escapedPrefix}`).test(text)
  );
}

function approvalTargetsExactPath(text: string, path: string): boolean {
  const escapedPath = escapeRegExp(path);
  return (
    new RegExp(`"path"\\s*:\\s*"${escapedPath}"`).test(text) ||
    new RegExp(`\\b(?:Writing|Editing|Deleting|Renaming) file:\\s*${escapedPath}\\b`).test(text) ||
    new RegExp(`\\b(?:Create|Edit|Move|Rename|Delete)\\s+${escapedPath}\\b`).test(text)
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function closeModalIfOpen(): Promise<void> {
  const modal = await $(".modal-container");
  if (await modal.isExisting()) {
    await browser.keys("Escape");
    await modal.waitForExist({ reverse: true, timeout: 5_000 });
  }
}

async function runNewSlashConversation(): Promise<void> {
  await sendPrompt("/new");
  await browser.waitUntil(
    async () => {
      const text = await browser.execute(() => document.querySelector<HTMLElement>(".agentic-chat-messages")?.innerText ?? "");
      return text.trim().length === 0 || text.includes("Ask anything about your vault.");
    },
    { timeout: 5_000, timeoutMsg: "/new did not clear the transcript" },
  );
}

async function waitForTurnToFinish(): Promise<void> {
  await browser.waitUntil(
    async () => {
      const stopVisible = await $(".agentic-chat-stop").isDisplayed().catch(() => false);
      const approvalOpen = await $(".agentic-chat-approval").isExisting().catch(() => false);
      const askUserOpen = await $(".agentic-chat-ask-user").isExisting().catch(() => false);
      return !stopVisible && !approvalOpen && !askUserOpen;
    },
    { timeout: TURN_TIMEOUT_MS, timeoutMsg: "live dogfood turn did not finish" },
  );
}

async function runPromptWithApprovals(
  noteDir: string,
  prompt: string,
  options: ApprovalPumpOptions = {},
): Promise<ApprovalDecision[]> {
  const decisions: ApprovalDecision[] = [];
  const beforeErrors = await renderedErrorCount();
  const stopApprovals = startApprovalPump(noteDir, decisions, options);
  try {
    await sendPrompt(prompt);
    await waitForTurnToFinish();
  } finally {
    stopApprovals();
  }
  const errors = await renderedErrorsSince(beforeErrors);
  expect(errors).toBe("");
  return decisions;
}

function dogfoodMcpServerSnapshot(): unknown {
  return {
    id: "dogfood_bad",
    name: "Dogfood Bad MCP",
    url: "not-a-valid-mcp-url",
    enabled: true,
    authType: "none",
    authHeaderName: "",
    authHeaderValueSecretId: "mcp:dogfood_bad:auth-header-value",
    authHeaderValue: "",
    oauth: {
      clientId: "",
      clientSecretSecretId: "",
      clientSecret: "",
      dynamicClientRegistration: false,
      registeredRedirectUri: "",
      authorizationServer: "",
      authorizationEndpoint: "",
      tokenEndpoint: "",
      registrationEndpoint: "",
      resourceMetadataUrl: "",
      accessTokenSecretId: "",
      accessToken: "",
      refreshTokenSecretId: "",
      refreshToken: "",
      expiresAt: 0,
      scope: "",
    },
    approval: "ask",
    knownTools: [],
  };
}

function kbPath(noteDir: string, relativePath: string): string {
  return `${noteDir}/Workspace KB/${relativePath}`;
}

function hasYamlFrontmatter(body: string): boolean {
  return body.trimStart().startsWith("---\n");
}

function repoBatchPrompt(noteDir: string, targets: RepoTarget[]): string {
  return [
    "Build the workspace knowledge base in the vault using the configured external workspace root.",
    "Create or update exactly one repository profile note for each repo listed below.",
    `Use this ordered folder structure: ${noteDir}/Workspace KB/01 Repositories/.`,
    "Every note must include YAML frontmatter in the initial write with at least tags, repo_path, and note_type fields.",
    "Do not use a separate set_properties call for new notes; put metadata in YAML frontmatter in the write content.",
    "For each repo, use external_inspect list/read/search. Read README/AGENTS plus manifests where present: package.json, pyproject.toml, go.mod, Cargo.toml, Dockerfile, docker-compose.yml, compose.yaml, Pulumi.yaml, .gitlab-ci.yml, Chart.yaml, kustomization.yaml.",
    "Each repository note must include: purpose, ownership/context, tech stack, local developer commands, CI/deployment signals, runtime/infrastructure signals, observability signals, security/auth/secrets notes, open questions, and Sources.",
    "If a file is missing, say it is missing; do not invent details. Do not inspect .env, token, key, generated dependency, or private files.",
    "Every Sources section must include external:// citations to the concrete files or directories used.",
    `Only write under ${noteDir}/Workspace KB/.`,
    "",
    ...targets.flatMap((target) => [
      `${target.index}. Repo external path: ${target.repoPath}`,
      `   Vault note: ${kbPath(noteDir, target.notePath)}`,
      `   Repo label: ${target.label}`,
    ]),
  ].join("\n");
}

function liveDogfoodReportManifest(options: {
  vaultPath: string;
  externalRoot: string;
  noteDir: string;
  workspaceLabel: string;
  indexPath: string;
  techMapPath: string;
}): DogfoodManifest {
  const overviewPath = kbPath(options.noteDir, "00 Overview/README.md");
  const learningPath = kbPath(options.noteDir, "00 Overview/DevOps Learning Path.md");
  const workflowPath = kbPath(options.noteDir, "02 Workflows/Operational Workflows.md");
  const qaPath = kbPath(options.noteDir, "99 QA/Live Dogfood QA.md");
  return {
    version: 1,
    runId: process.env.DOGFOOD_RUN_ID?.trim() || `live-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    createdAt: new Date().toISOString(),
    vaultPath: options.vaultPath,
    externalRoot: options.externalRoot,
    secretText: "DOGFOOD_LIVE_SECRET_SENTINEL_NOT_PRESENT",
    expectedActiveNote: `${options.noteDir}/Dogfood Scratch.md`,
    ignoredGlobs: [],
    allowedMutationRoots: [`${options.noteDir}/`],
    deniedMutationPaths: ["AGENTS.md"],
    requiredTools: ["read", "vault_inspect", "write", "edit", "delete", "external_inspect"],
    maxRepeatedExternalReadCount: 2,
    requiredGeneratedNotes: [
      {
        path: options.indexPath,
        frontmatter: true,
        requiredSubstrings: ["external://"],
      },
      {
        path: options.techMapPath,
        frontmatter: true,
        requiredSubstrings: ["external://"],
      },
      ...REPO_TARGETS.map((target) => ({
        path: kbPath(options.noteDir, target.notePath),
        frontmatter: true,
        requiredSubstrings: [target.label, `external://${target.repoPath}`],
      })),
      {
        path: overviewPath,
        frontmatter: true,
        requiredSubstrings: REPO_TARGETS.map((target) => `[[${kbPath(options.noteDir, target.notePath)}|${target.label}]]`),
      },
      {
        path: learningPath,
        frontmatter: true,
        requiredSubstrings: ["DevOps"],
      },
      {
        path: workflowPath,
        frontmatter: true,
        requiredSubstrings: ["external://"],
      },
      {
        path: qaPath,
        frontmatter: true,
        requiredSubstrings: ["external_inspect"],
      },
    ],
    repeatedExternalReads: [],
    maxUserMessageChars: 30_000,
  };
}

describe("agentic-chat live workspace dogfood", function () {
  const baseUrl = optionalEnv("AGENTIC_CHAT_BASE_URL", "AGENTIC_CHAT_LIVE_BASE_URL", "OPENWEBUI_BASE_URL") ?? "";
  const model = optionalEnv("AGENTIC_CHAT_MODEL", "AGENTIC_CHAT_LIVE_MODEL", "OPENWEBUI_MODEL") ?? "";
  const externalRoot = optionalEnv("AGENTIC_CHAT_LIVE_EXTERNAL_ROOT", "EXTERNAL_ROOT") ?? "";
  const noteDir = process.env.DOGFOOD_NOTE_DIR?.trim() || DEFAULT_NOTE_DIR;
  const workspaceLabel = process.env.DOGFOOD_WORKSPACE_LABEL?.trim() || "workspace";
  const indexPath = `${noteDir}/${workspaceLabel}-index.md`;
  const techMapPath = `${noteDir}/${workspaceLabel}-tech-map.md`;

  before(async function () {
    if (process.env.AGENTIC_CHAT_LIVE_DOGFOOD !== "true" && process.env.DOGFOOD_LIVE !== "true") this.skip();
    if (!baseUrl || !model || !externalRoot) this.skip();
    const apiKey = readApiKey();
    if (!apiKey) this.skip();

    const configured = await configureDogfoodSettings({ apiKey, baseUrl, model, externalRoot });
    if (!configured) throw new Error("agentic-chat plugin not found in the dogfood vault");
    await openDogfoodScratch(noteDir);
    await openChat();
    await startNewConversation();
  });

  it("runs status and directory diagnostics before the live prompt", async function () {
    const status = await runSlashCommand("/status");
    expect(status.toLowerCase()).toContain("openai-compatible");
    expect(status).toContain(model);

    const dirs = await runSlashCommand("/dirs");
    expect(dirs).toContain("External workspace root");
  });

  it("exercises slash commands and guarded command paths", async function () {
    const help = await runSlashCommand("/help");
    expect(help).toContain("/status");
    expect(help).toContain("/diagnostics");

    await runNewSlashConversation();

    const diagnostics = await runSlashCommand("/diagnostics");
    expect(diagnostics).toContain("Diagnostics");

    const config = await runSlashCommand("/config");
    expect(config).toContain("Mode");
    expect(config).toContain("Safe");

    const styleApplied = await runSlashCommand("/style learning");
    expect(styleApplied).toContain("Output style");
    expect(styleApplied).toContain("Learning");

    const styleList = await runSlashCommand("/style");
    expect(styleList).toContain("Output style");
    expect(styleList).toContain("Brainstorm");

    const effortApplied = await runSlashCommand("/effort off");
    expect(effortApplied).toContain("Effort");

    const effortList = await runSlashCommand("/effort");
    expect(effortList).toContain("Effort");

    const usage = await runSlashCommand("/usage");
    expect(usage).toContain("Usage");

    const dirs = await runSlashCommand("/dirs");
    expect(dirs).toContain("External workspace root");

    const addDir = await runSlashCommand(`/add-dir ${externalRoot}`);
    expect(addDir).toContain("External workspace root");

    const projects = await runSlashCommand("/project");
    expect(projects).toContain("Projects");
    expect(projects).toContain("Vault-wide");

    const memoryAdd = await runSlashCommand("/memory add fact vault Dogfood slash command sweep marker.");
    expect(memoryAdd).toContain("Memory");

    const memoryManage = await runSlashCommand("/memory manage");
    expect(memoryManage).toContain("Dogfood slash command sweep marker");

    const memoryExport = await runSlashCommand("/memory export");
    expect(memoryExport).toContain("Memory");

    const semanticStatus = await runSlashCommand("/semantic-index status");
    expect(semanticStatus).toContain("Semantic index");

    const semanticCancel = await runSlashCommand("/semantic-index cancel");
    expect(semanticCancel).toContain("Semantic index");

    const plan = await runSlashCommand("/plan");
    expect(plan).toContain("Plan");
    expect(plan).toContain("Read-only");

    const planBadge = await $(".agentic-chat-plan-badge");
    await expect(planBadge).toBeDisplayed();
    await planBadge.click();
    await expect(planBadge).not.toBeDisplayed();

    const todoAdd = await runSlashCommand("/todo add Live dogfood slash sweep");
    expect(todoAdd).toContain("Plan tracker");

    const todoSet = await runSlashCommand("/todo set 1 active");
    expect(todoSet).toContain("Plan tracker");

    const todoTest = await runSlashCommand("/todo test 1 passed");
    expect(todoTest).toContain("tests passed");

    const todoCommit = await runSlashCommand("/todo commit 1 dogfood123");
    expect(todoCommit).toContain("commit dogfood123");

    const skills = await runSlashCommand("/skill");
    expect(skills).toContain("Skills");

    const template = await runSlashCommand("/template");
    expect(template).toContain("Deprecated");

    const agents = await runSlashCommand("/agent");
    expect(agents).toContain("Subagents");

    const sessionsBefore = await getSessionCount();
    await sendPrompt("/sessions");
    await $(".modal-container").waitForExist({ timeout: 10_000 });
    await closeModalIfOpen();
    expect(await getSessionCount()).toBe(sessionsBefore);

    await sendPrompt("/model");
    await $(".modal-container").waitForExist({ timeout: 10_000 });
    await closeModalIfOpen();

    const sessionsClearGuard = await runSlashCommand("/sessions clear");
    expect(sessionsClearGuard).toContain("Re-run with /sessions clear --confirm");

    const memoryClearGuard = await runSlashCommand("/memory clear");
    expect(memoryClearGuard).toContain("Re-run with /memory clear --confirm");

    const errors = await renderedErrors();
    expect(errors).toBe("");
  });

  it("restores accidental top-level AGENTS.md init edits through the agent", async function () {
    const current = await readNote("AGENTS.md");
    if (!current.trim() || current.trim() === AGENTS_BASELINE) return;
    expect(current).toContain("Agentic Chat Instructions");

    const decisions: ApprovalDecision[] = [];
    const beforeErrors = await renderedErrorCount();
    const stopApprovals = startApprovalPump(noteDir, decisions, { allowExactPaths: ["AGENTS.md"] });
    try {
      await sendPrompt(
        [
          "Restore the top-level vault note AGENTS.md.",
          `Replace its entire content with exactly this single line and nothing else: ${AGENTS_BASELINE}`,
          "Do not modify any other file. Do not inspect the external root. Do not set note properties.",
        ].join("\n"),
      );
      await waitForTurnToFinish();
    } finally {
      stopApprovals();
    }

    expect(decisions.some((decision) => decision.action === "allow")).toBe(true);
    expect((await readNote("AGENTS.md")).trim()).toBe(AGENTS_BASELINE);
    expect(await renderedErrorsSince(beforeErrors)).toBe("");
  });

  it("honors live tool approval setting changes and restores them", async function () {
    const original = await getApprovalSnapshot();
    const deniedPath = kbPath(noteDir, `99 QA/Approval Denied ${Date.now()}.md`);
    const allowedPath = kbPath(noteDir, `99 QA/Approval Allowed ${Date.now()}.md`);

    try {
      await setApprovalSnapshot({
        ...original,
        mutating: "ask",
        perTool: { ...original.perTool, write: "deny" },
      });

      const denyDecisions: ApprovalDecision[] = [];
      const beforeDenyErrors = await renderedErrorCount();
      const stopDenyApprovals = startApprovalPump(noteDir, denyDecisions);
      try {
        await sendPrompt(
          `Create ${deniedPath} with exactly this body: # Approval Denied\n\nThis note should not be created while write is denied.`,
        );
        await waitForTurnToFinish();
      } finally {
        stopDenyApprovals();
      }

      expect(await noteExists(deniedPath)).toBe(false);
      expect(denyDecisions.some((decision) => decision.action === "allow")).toBe(false);
      expect(await renderedErrorsSince(beforeDenyErrors)).not.toContain("OpenAI-compatible request failed");

      await setApprovalSnapshot({
        ...original,
        mutating: "ask",
        perTool: { ...original.perTool, write: "ask" },
      });

      const allowDecisions = await runPromptWithApprovals(
        noteDir,
        `Create ${allowedPath} with exactly this body: # Approval Allowed\n\nThis note should be created after write is set back to ask.`,
      );
      expect(allowDecisions.some((decision) => decision.title.includes("Write file") && decision.action === "allow")).toBe(true);
      expect(await noteExists(allowedPath)).toBe(true);

      const undoResult = await runSlashCommand("/undo");
      expect(undoResult).toContain("Undo");
      if (await noteExists(allowedPath)) {
        const secondUndoResult = await runSlashCommand("/undo");
        expect(secondUndoResult).toContain("Undo");
      }
      expect(await noteExists(allowedPath)).toBe(false);
    } finally {
      await setApprovalSnapshot(original);
    }

    expect(await getApprovalSnapshot()).toEqual(original);
  });

  it("honors live tool-budget and external-root setting toggles and restores them", async function () {
    const original = await getToggleSettingsSnapshot();

    try {
      await setToggleSettingsSnapshot({
        ...original,
        toolBudget: { ...original.toolBudget, enabled: false },
      });
      await startNewConversation();

      const disabledDiagnostics = await runSlashCommandDelta("/diagnostics");
      expect(disabledDiagnostics).toContain("Tool budget");
      expect(disabledDiagnostics).toContain("off");

      await setToggleSettingsSnapshot({
        ...original,
        external: { ...original.external, approval: "deny" },
      });
      await startNewConversation();

      const denyDecisions = await runPromptWithApprovals(
        noteDir,
        [
          "Use external_inspect to read repo-inventory.tsv from the configured external root.",
          "After the tool result or denial, reply exactly: external-deny-ok",
          "Do not write files. Do not inspect any other path.",
        ].join("\n"),
      );
      expect(denyDecisions.some((decision) => decision.action === "allow")).toBe(false);
      expect(await latestApprovalDecisionCount("external_inspect", "denied")).toBeGreaterThan(0);
      expect(await latestSessionText()).toContain(
        "External workspace inspection is disabled by your external root approval settings.",
      );

      await setToggleSettingsSnapshot({
        ...original,
        external: { ...original.external, approval: "ask" },
      });
      await startNewConversation();

      const askDecisions = await runPromptWithApprovals(
        noteDir,
        [
          "Use external_inspect to read repo-inventory.tsv from the configured external root.",
          "After reading it, reply exactly: external-ask-restored-ok",
          "Do not write files. Do not inspect any other path.",
        ].join("\n"),
      );
      expect(askDecisions.some((decision) => decision.title.includes("Inspect external root") && decision.action === "allow")).toBe(
        true,
      );
      expect(await latestApprovalDecisionCount("external_inspect", "approved")).toBeGreaterThan(0);
      expect(await latestSessionText()).toContain("external://repo-inventory.tsv");
    } finally {
      await setToggleSettingsSnapshot(original);
      await startNewConversation();
      await openDogfoodScratch(noteDir);
      await openChat();
    }

    expect(await getToggleSettingsSnapshot()).toEqual(original);
  });

  it("exercises model setting changes and restores the live model", async function () {
    const original = await getModelSettingsSnapshot();
    const invalidModel = `${model}-dogfood-invalid`;

    try {
      await setModelSettingsSnapshot({ openaiCompatibleModel: invalidModel });
      await startNewConversation();

      const invalidStatus = await runSlashCommand("/status");
      expect(invalidStatus).toContain(invalidModel);

      await setModelSettingsSnapshot(original);
      await startNewConversation();

      const restoredStatus = await runSlashCommand("/status");
      expect(restoredStatus).toContain(original.openaiCompatibleModel);

      await sendPrompt("Reply exactly: model-restore-ok");
      await waitForTurnToFinish();
      expect(await browser.execute(() => document.querySelector<HTMLElement>(".agentic-chat-messages")?.innerText ?? "")).toMatch(
        /model-restore-ok/i,
      );
      expect(await renderedErrors()).toBe("");
    } finally {
      await setModelSettingsSnapshot(original);
      await startNewConversation();
      await openDogfoodScratch(noteDir);
      await openChat();
    }
  });

  it("exercises MCP disabled and bad-endpoint diagnostics without calling a remote MCP server", async function () {
    const original = await getMcpSettingsSnapshot();

    try {
      await setMcpSettingsSnapshot({ ...original, enabled: false, servers: [] });
      await startNewConversation();
      const disabledDiagnostics = await runSlashCommandDelta("/diagnostics");
      expect(disabledDiagnostics).toContain("MCP");

      await setMcpSettingsSnapshot({
        enabled: true,
        proxyUrl: "",
        noProxy: "localhost,127.0.0.1,::1",
        servers: [dogfoodMcpServerSnapshot()],
      });
      await startNewConversation();

      const badEndpointDiagnostics = await runSlashCommandDelta("/diagnostics");
      expect(badEndpointDiagnostics).toContain("MCP");
      expect(badEndpointDiagnostics).toContain("Dogfood Bad MCP");
      expect(badEndpointDiagnostics).toContain("not-a-valid-mcp-url");
    } finally {
      await setMcpSettingsSnapshot(original);
      await startNewConversation();
      await openDogfoodScratch(noteDir);
      await openChat();
    }

    expect(await getMcpSettingsSnapshot()).toEqual(original);
  });

  it("exercises model-backed slash commands, export, undo, and init guardrails", async function () {
    await sendPrompt("/steer Reply exactly: slash-steer-ok");
    await waitForTurnToFinish();
    expect(await browser.execute(() => document.querySelector<HTMLElement>(".agentic-chat-messages")?.innerText ?? "")).toMatch(
      /slash-steer-ok/i,
    );

    await sendPrompt("/follow-up Reply exactly: slash-follow-up-ok");
    await waitForTurnToFinish();
    expect(await browser.execute(() => document.querySelector<HTMLElement>(".agentic-chat-messages")?.innerText ?? "")).toMatch(
      /slash-follow-up-ok/i,
    );

    await sendPrompt("/redirect Reply exactly: slash-redirect-ok");
    await waitForTurnToFinish();
    expect(await browser.execute(() => document.querySelector<HTMLElement>(".agentic-chat-messages")?.innerText ?? "")).toMatch(
      /slash-redirect-ok/i,
    );

    const undoPath = kbPath(noteDir, `99 QA/Undo Check ${Date.now()}.md`);
    await runPromptWithApprovals(
      noteDir,
      `Create ${undoPath} with exactly this body: # Undo Check\n\nThis note should be removed by /undo.`,
    );
    expect(await noteExists(undoPath)).toBe(true);

    const firstUndo = await runSlashCommand("/undo");
    expect(firstUndo).toContain("Undo");
    if (await noteExists(undoPath)) {
      const secondUndo = await runSlashCommand("/undo");
      expect(secondUndo).toContain("Undo");
    }
    expect(await noteExists(undoPath)).toBe(false);

    const exported = await runSlashCommand("/export");
    expect(exported).toContain("Export");
    expect(exported).toContain("Saved");
    expect(await activeFilePath()).toBe(`${noteDir}/Dogfood Scratch.md`);
    await openChat();

    const initDecisions: ApprovalDecision[] = [];
    const beforeInitErrors = await renderedErrorCount();
    const stopApprovals = startApprovalPump(noteDir, initDecisions);
    try {
      await sendPrompt("/init");
      await waitForTurnToFinish();
    } finally {
      stopApprovals();
    }
    expect(initDecisions.some((decision) => decision.action === "deny")).toBe(true);

    expect(await renderedErrorsSince(beforeInitErrors)).not.toContain("OpenAI-compatible request failed");
    await openDogfoodScratch(noteDir);
    await openChat();
  });

  it("handles ambiguous delete requests conservatively and recovers from delete denial", async function () {
    await startNewConversation();
    await openDogfoodScratch(noteDir);
    await openChat();

    const sentinelPath = kbPath(noteDir, `99 QA/Ambiguous Delete Sentinel ${Date.now()}.md`);
    const createDecisions = await runPromptWithApprovals(
      noteDir,
      [
        `Create exactly one vault note at ${sentinelPath}.`,
        "Use this exact body:",
        "---",
        "tags:",
        "  - dogfood",
        "note_type: qa",
        "---",
        "# Ambiguous Delete Sentinel",
        "",
        "This note proves unclear delete requests do not remove scoped dogfood evidence.",
        "",
        "Do not inspect the external root. Do not modify any other file.",
      ].join("\n"),
    );
    expect(createDecisions.some((decision) => decision.title.includes("Write file") && decision.action === "allow")).toBe(true);
    expect(await noteExists(sentinelPath)).toBe(true);

    const deleteDecisions = await runPromptWithApprovals(
      noteDir,
      [
        "Delete the bad dogfood notes.",
        "I am intentionally not telling you which notes are bad.",
        "If the target is ambiguous, ask a clarifying question and do not delete anything.",
        "Do not write files, edit files, inspect the external root, or delete folders.",
      ].join("\n"),
      { denyMutationTitleIncludes: ["Delete file"] },
    );

    expect(await noteExists(sentinelPath)).toBe(true);
    expect(deleteDecisions.filter((decision) => decision.title.includes("Delete file")).every((decision) => decision.action === "deny")).toBe(
      true,
    );
    expect(await renderedErrors()).not.toContain("OpenAI-compatible request failed");
  });

  it("refines duplicate notes through edit and delete approvals while preserving links", async function () {
    await startNewConversation();
    await openDogfoodScratch(noteDir);
    await openChat();

    const stamp = Date.now();
    const sourcePath = kbPath(noteDir, `99 QA/Refine Source ${stamp}.md`);
    const duplicatePath = kbPath(noteDir, `99 QA/Refine Duplicate ${stamp}.md`);

    await runPromptWithApprovals(
      noteDir,
      [
        "Create exactly two vault notes for a dogfood refinement test:",
        `1. ${sourcePath}`,
        `2. ${duplicatePath}`,
        "Both notes must include YAML frontmatter with tags and note_type.",
        "The source note should say it is the durable QA note.",
        "The duplicate note should say it is redundant but contains the phrase duplicate detail to preserve.",
        "Do not inspect the external root. Do not modify any other file.",
      ].join("\n"),
    );
    expect(await noteExists(sourcePath)).toBe(true);
    expect(await noteExists(duplicatePath)).toBe(true);

    const refineDecisions = await runPromptWithApprovals(
      noteDir,
      [
        "Refine the dogfood QA notes using only these vault files:",
        `- Keep and edit ${sourcePath}`,
        `- Delete ${duplicatePath}`,
        "Move the useful phrase duplicate detail into the kept source note.",
        `Add an Obsidian link to [[${noteDir}/Dogfood Scratch|Dogfood Scratch]] in the kept note.`,
        "Do not inspect the external root. Do not modify any other file.",
      ].join("\n"),
    );

    expect(refineDecisions.some((decision) => decision.title.includes("Delete file") && decision.action === "allow")).toBe(true);
    expect(await noteExists(sourcePath)).toBe(true);
    expect(await noteExists(duplicatePath)).toBe(false);
    const source = await readNote(sourcePath);
    expect(source).toContain("duplicate detail");
    expect(source).toContain("[[");
  });

  it("builds initial workspace knowledge-base notes from the external root", async function () {
    await startNewConversation();
    await openDogfoodScratch(noteDir);
    await openChat();

    const decisions: ApprovalDecision[] = [];
    const stopApprovals = startApprovalPump(noteDir, decisions);
    try {
      await sendPrompt(
        [
          `Use the configured external workspace root to inspect ${workspaceLabel}.`,
          `Create or update ${indexPath} and ${techMapPath}.`,
          "Audience: a DevOps engineer considering joining the team who wants to learn the setup and tech stack.",
          "First read repo-inventory.tsv and repo-selection.md if they exist, then list the repo tree under repos/.",
          "Do not stop after one repo: the index note must mention every repo from the inventory or explicitly say why it was skipped.",
          "Scope source reads tightly: inspect README.md plus package.json, pyproject.toml, go.mod, Cargo.toml, Dockerfile, compose, Terraform, Helm, CI, and Kubernetes config where present for the most important repos.",
          "Use external_inspect list/read/search as needed and cite external files with external:// references.",
          "Both notes must include YAML frontmatter in the initial write with at least tags and note_type fields.",
          "Do not use a separate set_properties call for new notes; put metadata in YAML frontmatter in the write content.",
          "Each note must end with a Sources section containing external:// citations used for that note.",
          "Do not read or cite secrets, tokens, .env files, key files, generated dependency folders, or private directories.",
          "Write concise notes with repo purpose guesses, tech stack signals, local commands, DevOps-relevant components, and unknowns.",
          `Only write under ${noteDir}/.`,
        ].join("\n"),
      );
      await waitForTurnToFinish();
    } finally {
      stopApprovals();
    }

    const errors = await renderedErrors();
    expect(errors).toBe("");
    expect(decisions.some((decision) => decision.title.includes("Inspect external root") && decision.action === "allow")).toBe(true);
    expect(decisions.some((decision) => decision.action === "deny")).toBe(false);
    expect(await noteExists(indexPath)).toBe(true);
    expect(await noteExists(techMapPath)).toBe(true);

    const index = await readNote(indexPath);
    const techMap = await readNote(techMapPath);
    expect(index).toContain("external://");
    expect(techMap).toContain("external://");
    expect(hasYamlFrontmatter(index)).toBe(true);
    expect(hasYamlFrontmatter(techMap)).toBe(true);
    expect(index.length).toBeGreaterThan(200);
    expect(techMap.length).toBeGreaterThan(200);
    expect(await latestSessionLineCount()).toBeGreaterThan(0);
  });

  it("deepens the tech map from concrete repo manifests", async function () {
    await startNewConversation();
    await openDogfoodScratch(noteDir);
    await openChat();

    const decisions: ApprovalDecision[] = [];
    const stopApprovals = startApprovalPump(noteDir, decisions);
    try {
      await sendPrompt(
        [
          `Continue the ${workspaceLabel} knowledge base.`,
          `Update only ${techMapPath}; do not modify ${indexPath}.`,
          "Use external_inspect search with kind=files under repos/ for concrete manifest/config files: package.json, pyproject.toml, go.mod, Cargo.toml, Dockerfile, docker-compose.yml, compose.yaml, Pulumi.yaml, .gitlab-ci.yml, Chart.yaml, kustomization.yaml.",
          `Read representative manifests for the selected repos when present: ${REPO_TARGETS.map((target) => target.repoPath).join(", ")}.`,
          "Replace vague statements like 'look for Terraform or similar' with concrete findings and unknowns.",
          "Keep or add YAML frontmatter with at least tags and note_type fields.",
          "Do not use a separate set_properties call for this metadata; keep it in YAML frontmatter.",
          "The note must include a per-repo tech stack table, local/dev commands, CI/deployment signals, observability signals, and a Sources section with external:// citations to the manifests or READMEs used.",
          `Only write under ${noteDir}/.`,
        ].join("\n"),
      );
      await waitForTurnToFinish();
    } finally {
      stopApprovals();
    }

    const errors = await renderedErrors();
    expect(errors).toBe("");
    expect(decisions.some((decision) => decision.title.includes("Inspect external root") && decision.action === "allow")).toBe(true);
    expect(decisions.some((decision) => decision.action === "deny")).toBe(false);

    const techMap = await readNote(techMapPath);
    expect(techMap).toContain("external://repos/");
    expect(techMap.toLowerCase()).toContain("package.json");
    expect(techMap.toLowerCase()).not.toContain("look for terraform or similar");
    expect(hasYamlFrontmatter(techMap)).toBe(true);
    expect(await latestSessionLineCount()).toBeGreaterThan(0);
  });

  it("creates one ordered repository profile note per selected repo", async function () {
    await startNewConversation();
    await openDogfoodScratch(noteDir);
    await openChat();

    const batches = chunkRepoTargets(REPO_TARGETS, 3);

    for (const batch of batches) {
      const decisions = await runPromptWithApprovals(noteDir, repoBatchPrompt(noteDir, batch));
      expect(decisions.some((decision) => decision.title.includes("Inspect external root") && decision.action === "allow")).toBe(true);
      expect(decisions.some((decision) => decision.action === "deny")).toBe(false);
    }

    for (const target of REPO_TARGETS) {
      const path = kbPath(noteDir, target.notePath);
      expect(await noteExists(path)).toBe(true);
      const body = await readNote(path);
      expect(body).toContain(target.label);
      expect(body).toContain("Sources");
      expect(body).toContain(`external://${target.repoPath}`);
      expect(hasYamlFrontmatter(body)).toBe(true);
      expect(body.length).toBeGreaterThan(300);
    }
  });

  it("creates ordered overview and workflow notes from the repo profiles", async function () {
    await startNewConversation();
    await openDogfoodScratch(noteDir);
    await openChat();

    const overviewPath = kbPath(noteDir, "00 Overview/README.md");
    const learningPath = kbPath(noteDir, "00 Overview/DevOps Learning Path.md");
    const workflowPath = kbPath(noteDir, "02 Workflows/Operational Workflows.md");
    const qaPath = kbPath(noteDir, "99 QA/Live Dogfood QA.md");

    const decisions = await runPromptWithApprovals(
      noteDir,
      [
        "Use the existing dogfood repository profile notes and the configured external root to create ordered overview notes.",
        "Create or update exactly these vault notes:",
        `- ${overviewPath}`,
        `- ${learningPath}`,
        `- ${workflowPath}`,
        `- ${qaPath}`,
        "Every note must include YAML frontmatter in the initial write with at least tags and note_type fields.",
        "Do not use a separate set_properties call for new notes; put metadata in YAML frontmatter in the write content.",
        "The README must link to every repository profile note using the exact vault paths below, not short aliases:",
        ...REPO_TARGETS.map((target) => `- [[${kbPath(noteDir, target.notePath)}|${target.label}]]`),
        "Group repository profile links by service, application, infrastructure/configuration, and docs/operations areas when those categories are visible.",
        "The DevOps Learning Path should be tailored for a DevOps engineer joining the team, with week-by-week topics, repos to read, commands to try, and open questions.",
        "The Operational Workflows note should cover local dev, CI/release, deployment/runtime, observability, dependency management, and incident handling, using external:// citations.",
        "The QA note should record that the live harness exercised slash commands, approval allow/deny paths, external_inspect, write/edit/set_properties, session export, memory, semantic-index status, todo, plan mode, and undo/export guards where applicable.",
        `Only write under ${noteDir}/.`,
      ].join("\n"),
    );

    expect(decisions.some((decision) => decision.action === "deny")).toBe(false);
    for (const path of [overviewPath, learningPath, workflowPath, qaPath]) {
      expect(await noteExists(path)).toBe(true);
      const body = await readNote(path);
      expect(hasYamlFrontmatter(body)).toBe(true);
      expect(body.length).toBeGreaterThan(300);
    }
    expect(await readNote(overviewPath)).toContain("[[");
    expect(await readNote(workflowPath)).toContain("external://");
  });

  it("optionally writes a next-level live dogfood report", async function () {
    if (process.env.DOGFOOD_WRITE_REPORT !== "true") this.skip();

    const manifest = liveDogfoodReportManifest({
      vaultPath: optionalEnv("TARGET_VAULT", "AGENTIC_CHAT_LIVE_VAULT") ?? "",
      externalRoot,
      noteDir,
      workspaceLabel,
      indexPath,
      techMapPath,
    });
    const result = await assertDogfoodInvariants(manifest);
    const reportPath = await writeDogfoodRunReport(result);
    const errors = result.findings.filter((finding) => finding.severity === "error");

    expect(reportPath).toContain(`${manifest.runId}-summary.md`);
    expect(errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("optionally cleans stale dogfood artifacts through the agent", async function () {
    if (process.env.DOGFOOD_CLEANUP !== "true") this.skip();

    const stalePaths = [
      `${noteDir}/Workspace Technology Mindmap.md`,
      kbPath(noteDir, "99 QA/Undo Check.md"),
    ];
    const existing = [];
    for (const path of stalePaths) {
      if (await noteExists(path)) existing.push(path);
    }
    if (existing.length === 0) return;

    const decisions = await runPromptWithApprovals(
      noteDir,
      [
        "Clean up stale dogfood artifacts. Delete exactly these vault notes and no others:",
        ...existing.map((path) => `- ${path}`),
        "Do not inspect the external root. Do not delete folders.",
      ].join("\n"),
    );

    expect(decisions.some((decision) => decision.action === "deny")).toBe(false);
    for (const path of existing) expect(await noteExists(path)).toBe(false);
  });
});
