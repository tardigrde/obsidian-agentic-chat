import { browser, expect, $ } from "@wdio/globals";
import { before, describe, it } from "mocha";
import { lstat, mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import {
  configureLivePlugin,
  readLatestSessionRaw,
  sendPrompt,
  TURN_TIMEOUT_MS,
} from "./dogfood-helpers";

/**
 * Marketplace live dogfood (M1): installs a real Agent Plugins 1.0.0 package
 * from the ai-marketplace repo (https://github.com/tardigrde/ai-marketplace,
 * `plugins/swe`) into the vault's `.agentic-plugins/`, then drives a real
 * model through:
 *   - a `/skill` invocation backed by the package's SKILL.md
 *   - an MCP tool call to the package's `mcp.json` server (Context7, no auth)
 *   - a `/doctor` audit that lists the package and its server
 *
 * The package is fetched from GitHub by default so the test is reproducible
 * on any machine. Gated on `AGENTIC_CHAT_API_KEY` (spends real tokens):
 *
 *   AGENTIC_CHAT_API_KEY=sk-or-... npm run test:e2e:dogfood \
 *     -- --spec test/e2e/dogfood/marketplace-live.dogfood.ts
 *
 * Env overrides:
 *   AGENTIC_CHAT_MARKETPLACE_URL   git URL to clone (default: https://github.com/tardigrde/ai-marketplace.git)
 *   AGENTIC_CHAT_MARKETPLACE_REF   git ref to clone (default: 20bedd4 — bump deliberately after reviewing the package)
 *   AGENTIC_CHAT_MARKETPLACE_PATH  use a local checkout instead of cloning (offline development)
 */
const MARKETPLACE_URL = "https://github.com/tardigrde/ai-marketplace.git";
/** Reviewed immutable marketplace revision; the env override is the update mechanism. */
const MARKETPLACE_REF = "20bedd4";

function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

/** Wait for the agent to finish so local slash commands are accepted. */
async function waitForAgentIdle(timeout = TURN_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const stop = await $(".agentic-chat-stop");
    if (!(await stop.isDisplayed())) return;
    // Some gateways never send the trailing stream close; terminate the run.
    await stop.click();
    await browser.pause(500);
  }
  throw new Error("agent never finished responding");
}

/** Send a prompt and wait for the turn to start AND finish. */
async function runTurn(prompt: string): Promise<void> {
  await sendPrompt(prompt);
  await $(".agentic-chat-stop").waitForExist({
    timeout: 30_000,
    timeoutMsg: "turn never started (runtime resources may be slow to load)",
  });
  await waitForAgentIdle();
}

/** Latest visible chat text. */
async function chatText(): Promise<string> {
  return await browser.execute(() => document.querySelector(".agentic-chat-view")?.textContent ?? "");
}

async function openChat(): Promise<void> {
  await browser.executeObsidianCommand("agentic-chat:open-chat");
  await $(".agentic-chat-view").waitForExist();
}

describe("agentic-chat marketplace live dogfood", function () {
  const apiKey = process.env.AGENTIC_CHAT_API_KEY?.trim();
  const baseUrl = process.env.AGENTIC_CHAT_BASE_URL?.trim() || "https://openrouter.ai/api/v1";
  const model = process.env.AGENTIC_CHAT_MODEL?.trim() || "openrouter/auto";
  const marketplaceUrl = process.env.AGENTIC_CHAT_MARKETPLACE_URL?.trim() || MARKETPLACE_URL;
  const marketplaceRef = process.env.AGENTIC_CHAT_MARKETPLACE_REF?.trim() || MARKETPLACE_REF;
  const localMarketplaceRoot = process.env.AGENTIC_CHAT_MARKETPLACE_PATH?.trim();
  let sweRoot: string;

  /** Clone (or reuse the local checkout of) the marketplace repo and return the swe package root. */
  async function resolveSweRoot(): Promise<string> {
    if (localMarketplaceRoot) {
      const candidate = path.join(path.resolve(localMarketplaceRoot), "plugins", "swe");
      await stat(candidate);
      return candidate;
    }
    const scratch = await mkdtemp(path.join(tmpdir(), "agentic-chat-marketplace-"));
    const cloneDir = path.join(scratch, "ai-marketplace");
    // Clone without checkout, then check out the ref — works for both branch
    // names and commit SHAs (the pinned default).
    await runCommand("git", ["clone", "--no-checkout", marketplaceUrl, cloneDir]);
    await runCommand("git", ["-C", cloneDir, "checkout", marketplaceRef]);
    return path.join(cloneDir, "plugins", "swe");
  }

  /** Package files (vault-relative path → content) read from the marketplace repo. */
  async function readSwePackage(): Promise<Array<[string, string]>> {
    const files: Array<[string, string]> = [];
    const walk = async (vaultRel: string, fsPath: string): Promise<void> => {
      const entry = await lstat(fsPath);
      if (entry.isSymbolicLink()) {
        throw new Error(`Marketplace package contains a symbolic link: ${fsPath}`);
      }
      if (entry.isDirectory()) {
        for (const child of (await readdir(fsPath)).sort()) {
          await walk(`${vaultRel}/${child}`, path.join(fsPath, child));
        }
        return;
      }
      files.push([vaultRel, await readFile(fsPath, "utf8")]);
    };
    await walk(".agentic-plugins/swe", sweRoot);
    return files;
  }

  before(async function () {
    if (!apiKey) this.skip();

    // 1. Fetch the package: clone from GitHub (or use the local checkout).
    sweRoot = await resolveSweRoot();

    // 2. Configure the live provider so the AgentService is built against it.
    await configureLivePlugin({ apiKey, baseUrl, model, provider: "openai-compatible" });

    // 3. Install the real package from the marketplace repo into the vault.
    //    The running session's file tree does not pick up brand-new dot
    //    folders, so the loader's adapter fallback (which reads the real
    //    disk state) is what surfaces the package here — same path a user
    //    hitting a stale tree would take.
    const files = await readSwePackage();
    await browser.executeObsidian(async ({ app }, packageFiles) => {
      // Make the install idempotent: drop a previous run's package from disk
      // (the tree cannot see it, so the adapter removes it).
      try {
        await app.vault.adapter.rmdir(".agentic-plugins", true);
      } catch {
        // Nothing installed yet.
      }
      const created = new Set<string>();
      const ensureParentFolders = async (vaultRel: string): Promise<void> => {
        const segments = vaultRel.split("/");
        let current = "";
        for (let index = 0; index < segments.length - 1; index += 1) {
          current = current ? `${current}/${segments[index]}` : segments[index] ?? "";
          if (created.has(current)) continue;
          created.add(current);
          if (!app.vault.getAbstractFileByPath(current)) {
            try {
              await app.vault.createFolder(current);
            } catch {
              // Already on disk (the vault tree does not track brand-new dot
              // folders, so the existence check above can miss it).
            }
          }
        }
      };
      for (const [vaultRel, content] of packageFiles) {
        await ensureParentFolders(vaultRel);
        await app.vault.create(vaultRel, content);
      }
    }, files);

    // 4. Open the chat view, then wait until the package actually loads.
    await openChat();
    await browser.waitUntil(
      async () => {
        const names = await browser.executeObsidian(async ({ app }) => {
          const plugin = (app as unknown as {
            plugins?: { plugins?: Record<string, { pluginService?: { reload?: () => Promise<unknown[]> } }> };
          }).plugins?.plugins?.["agentic-chat"];
          const loaded = (await plugin?.pluginService?.reload?.()) ?? [];
          return (loaded as Array<{ name?: string }>).map((entry) => entry.name);
        });
        return names.includes("swe");
      },
      { timeout: 30_000, timeoutMsg: "swe package never loaded into the plugin service" },
    );

    // 4. Enable MCP and pre-approve the package's Context7 server so the model
    //    can call its tools without an approval modal.
    await browser.executeObsidian(async ({ app }) => {
      const plugin = (app as unknown as {
        plugins?: {
          plugins?: Record<
            string,
            {
              settings?: Record<string, unknown>;
              saveSettings?: () => Promise<void>;
              pluginService?: { reload?: () => Promise<Array<{ name?: string; mcpServers?: Array<{ id: string }> }>> };
            }
          >;
        };
      }).plugins?.plugins?.["agentic-chat"];
      const settings = plugin?.settings as
        | { mcp?: { enabled?: boolean; servers?: Array<Record<string, unknown>> } }
        | undefined;
      if (!plugin || !settings?.mcp) return;
      settings.mcp.enabled = true;
      const loaded = (await plugin.pluginService?.reload?.()) ?? [];
      const swe = loaded.find((entry) => entry.name === "swe");
      const context7 = swe?.mcpServers?.find((server) => server.id.includes("context7"));
      if (context7) {
        const mcpServers = settings.mcp.servers as Array<Record<string, unknown>>;
        const userServers = mcpServers.filter((server) => server.source !== "plugin");
        settings.mcp.servers = [...userServers, { ...context7, approval: "allow" }];
      }
      await plugin.saveSettings?.();
    });
  });

  it("invokes a skill from the installed marketplace package", async function () {
    this.timeout(TURN_TIMEOUT_MS + 60_000);
    await sendPrompt('/skill code-review Review this snippet: function getToken() { return "sk-123456"; }');
    await $(".agentic-chat-stop").waitForExist({ timeout: 30_000, timeoutMsg: "skill turn never started" });
    await browser.waitUntil(
      async () => {
        const text = await chatText();
        return /security|hardcoded/i.test(text);
      },
      { timeout: TURN_TIMEOUT_MS, timeoutMsg: "skill turn did not produce a review" },
    );
    await waitForAgentIdle();
  });

  it("calls the package's Context7 MCP server through a live tool round trip", async function () {
    this.timeout(TURN_TIMEOUT_MS + 60_000);
    await runTurn(
      'Use the context7 MCP tool to look up the latest stable React version, then state the version in one line.',
    );

    // Deterministic proof the model actually called the package's server.
    await browser.waitUntil(
      async () => (await readLatestSessionRaw()).includes("mcp__plugin_swe_context7"),
      { timeout: TURN_TIMEOUT_MS, timeoutMsg: "model never called the context7 MCP server" },
    );
    const text = await chatText();
    expect(text).toMatch(/react/i);
  });

  it("reports the package and its server through /doctor", async function () {
    await waitForAgentIdle();
    await sendPrompt("/doctor");
    await browser.waitUntil(
      async () => {
        const text = await chatText();
        return text.includes("**swe**") && text.includes("context7");
      },
      { timeout: 30_000, timeoutMsg: "/doctor did not report the swe package and its context7 server" },
    );
  });

  it("materializes the builtins package with the install-plugin skill", async function () {
    await waitForAgentIdle();
    const present = await browser.executeObsidian(async ({ app }) => {
      const plugin = (app as unknown as {
        plugins?: { plugins?: Record<string, { pluginService?: { ensureBuiltinsMaterialized?: () => Promise<boolean> } }> };
      }).plugins?.plugins?.["agentic-chat"];
      // The before-hook rmdir's .agentic-plugins to reset the swe install, so
      // recreate the builtins package the way a user would via Repair built-ins.
      await plugin?.pluginService?.ensureBuiltinsMaterialized?.();
      const base = ".agentic-plugins/builtins";
      const docs = [
        "plugin.json",
        "README.md",
        "skills/self-knowledge/SKILL.md",
        "skills/install-plugin/SKILL.md",
      ];
      for (const rel of docs) {
        if (!app.vault.getAbstractFileByPath(`${base}/${rel}`)) return false;
      }
      return true;
    });
    expect(present).toBe(true);

    const skillNames = await browser.executeObsidian(async ({ app }) => {
      const plugin = (app as unknown as {
        plugins?: { plugins?: Record<string, { pluginService?: { reload?: () => Promise<unknown[]> } }> };
      }).plugins?.plugins?.["agentic-chat"];
      const loaded = (await plugin?.pluginService?.reload?.()) ?? [];
      return (loaded as Array<{ name?: string }>).flatMap((entry) =>
        entry.name === "builtins" ? (entry as { skills?: Array<{ name?: string }> }).skills?.map((skill) => skill.name) ?? [] : [],
      );
    });
    expect(skillNames).toContain("install-plugin");
    expect(skillNames).toContain("self-knowledge");
  });

  it("drives the install-plugin skill through a live model turn", async function () {
    this.timeout(TURN_TIMEOUT_MS + 60_000);
    await sendPrompt("How do I install a skill from a GitHub repo? Use the /skill install-plugin guidance.");
    await $(".agentic-chat-stop").waitForExist({ timeout: 30_000, timeoutMsg: "install-plugin turn never started" });
    // chatText() covers the whole transcript (including the prompt above), so
    // scope the assertion to the last assistant message instead.
    await browser.waitUntil(
      async () => {
        const raw = await readLatestSessionRaw();
        const messages = raw
          .split("\n")
          .map((line) => {
            try {
              return JSON.parse(line) as { role?: string; content?: unknown };
            } catch {
              return null;
            }
          })
          .filter((entry): entry is { role: string; content?: unknown } => entry !== null && entry.role === "assistant");
        const last = messages[messages.length - 1];
        if (!last) return false;
        const text =
          typeof last.content === "string"
            ? last.content
            : Array.isArray(last.content)
              ? last.content.map((block) => (typeof block === "string" ? block : (block as { text?: string }).text ?? "")).join("\n")
              : "";
        return /Resources|agent-plugins\.org|owner\/repo/i.test(text);
      },
      { timeout: TURN_TIMEOUT_MS, timeoutMsg: "install-plugin skill turn did not produce guidance" },
    );
    await waitForAgentIdle();
  });
});
