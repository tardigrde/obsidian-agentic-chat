import { $, browser, expect } from "@wdio/globals";
import { after, before, describe, it } from "mocha";
import { expectWithinWindow, waitForComposerReady } from "../support/layout";
import { installScriptedTurns, textTurn, toolTurn } from "../support/scripted-stream";
import { openAgenticChatSettings, openMcpAdvancedFolds, closeAgenticChatSettings, selectSettingsTab, waitForSetting } from "../support/settings-ui";

const VIEW_TYPE_AGENT_CHAT = "agentic-chat-chat-view";
const MOBILE_WIDTH = Number(process.env.AGENTIC_CHAT_E2E_VIEWPORT_WIDTH || 390);
const MOBILE_HEIGHT = Number(process.env.AGENTIC_CHAT_E2E_VIEWPORT_HEIGHT || 844);
/** The parts of the chat a phone user must reach. */
const COMPOSER_PARTS = ['[data-ac="view"]', '[data-ac="composer-input"]', '[data-ac="send"]'];
const MOBILE_WRITE_PATH = "Mobile/E2E-Mobile-Approval.md";
const MOBILE_WRITE_BODY = "mobile approval write ok";
const MOBILE_BIG_WRITE_PATH = "Mobile/E2E-Mobile-Big.md";

async function setMobileViewport(): Promise<void> {
  const cdpBrowser = browser as typeof browser & {
    cdp?: (domain: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  if (cdpBrowser.cdp) {
    await cdpBrowser.cdp("Emulation", "setDeviceMetricsOverride", {
      width: MOBILE_WIDTH,
      height: MOBILE_HEIGHT,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await cdpBrowser.cdp("Emulation", "setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  }
  await browser.waitUntil(
    async () => {
      const width = await browser.execute(() => window.innerWidth);
      return width <= MOBILE_WIDTH + 80;
    },
    {
      timeout: 5_000,
      timeoutMsg: `Browser did not enter a phone-sized viewport (wanted ${MOBILE_WIDTH}px, got ${await browser.execute(() => window.innerWidth)}px)`,
    },
  );
}

async function openChat(): Promise<void> {
  await browser.executeObsidianCommand("agentic-chat:open-chat");
  await $('[data-ac="view"]').waitForExist();
  await waitForComposerReady();
}

async function sendPrompt(prompt: string): Promise<void> {
  await waitForComposerReady();
  const input = await $('[data-ac="composer-input"]');
  await input.click();
  await input.setValue(prompt);
  await $('[data-ac="send"]').click();
}

async function runSlashCommand(command: string): Promise<void> {
  await sendPrompt(command);
}

async function closeOpenModals(): Promise<void> {
  await browser.execute(() => {
    for (const close of Array.from(document.querySelectorAll<HTMLElement>(".modal-close-button"))) close.click();
    for (const backdrop of Array.from(document.querySelectorAll<HTMLElement>(".modal-bg"))) backdrop.click();
  });
}

async function seedMobileState(): Promise<void> {
  await browser.executeObsidian(async ({ app, obsidian }, writePath) => {
    const plugin = (app as unknown as {
      plugins?: {
        plugins?: Record<string, { settings?: Record<string, unknown>; saveSettings?: () => Promise<void> }>;
      };
      secretStorage?: { setSecret?: (id: string, value: string) => void };
    }).plugins?.plugins?.["agentic-chat"];
    if (!plugin?.settings) throw new Error("agentic-chat plugin not found");

    const settings = plugin.settings as {
      provider: string;
      openrouterApiKey: string;
      openrouterModel: string;
      mode: string;
      approval: { mutating: string; perTool: Record<string, string> };
      web: { enabled: boolean };
      mcp: { enabled: boolean; proxyUrl: string; noProxy: string };
      plugins: { mcpState: Record<string, unknown> };
      network: { proxyUrl: string; noProxy: string };
    };
    settings.provider = "openrouter";
    settings.openrouterApiKey = "e2e-mobile-scripted-key";
    settings.openrouterModel = "openai/gpt-4o-mini";
    settings.approval = { mutating: "ask", perTool: {} };
    settings.web.enabled = false;
    settings.mcp = {
      enabled: true,
      proxyUrl: "",
      noProxy: "localhost,127.0.0.1,::1",
    };
    // MCP endpoints live in plugin packages now. A disabled package still
    // renders the server header the mobile layout test measures.
    const demoRoot = ".agentic-plugins/mobile-demo";
    if (!app.vault.getAbstractFileByPath(demoRoot)) {
      await app.vault.createFolder(demoRoot);
      await app.vault.create(
        `${demoRoot}/plugin.json`,
        JSON.stringify({
          $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
          name: "mobile-demo",
        }),
      );
      await app.vault.create(
        `${demoRoot}/mcp.json`,
        JSON.stringify({
          $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
          mcpServers: { demo: { type: "streamable-http", url: "https://mcp.example.com/mcp" } },
        }),
      );
    }
    settings.plugins.mcpState["plugin_mobile_demo_demo"] = {
      enabled: false,
      approval: "ask",
      authType: "none",
      authHeaderName: "",
      authHeaderValueSecretId: "",
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
      knownTools: [],
      enabledTools: [],
      disabledTools: [],
      lastUrl: "https://mcp.example.com/mcp",
    } as never;
    settings.network = { proxyUrl: "", noProxy: "localhost,127.0.0.1,::1" };
    app.secretStorage?.setSecret?.("agentic-chat-openrouter-api-key", "e2e-mobile-scripted-key");
    await plugin.saveSettings?.();

    const existingMobileFolder = app.vault.getAbstractFileByPath("Mobile");
    if (!existingMobileFolder) await app.vault.createFolder("Mobile");
    const existingWrite = app.vault.getAbstractFileByPath(writePath);
    if (existingWrite instanceof obsidian.TFile) await app.vault.trash(existingWrite, true);

    const adapter = app.vault.adapter as unknown as {
      list: (path: string) => Promise<{ files: string[]; folders: string[] }>;
      mkdir: (path: string) => Promise<void>;
      exists: (path: string) => Promise<boolean>;
      remove: (path: string) => Promise<void>;
      write: (path: string, data: string) => Promise<void>;
    };
    const sessionsDir = `${app.vault.configDir}/plugins/agentic-chat/sessions`;
    try {
      const listing = await adapter.list(sessionsDir);
      await Promise.all(listing.files.filter((file) => file.endsWith(".jsonl")).map((file) => adapter.remove(file)));
    } catch {
      await adapter.mkdir(sessionsDir);
    }

    const cwd = `obsidian-vault:${app.vault.getName()}`;
    const session = (id: string, name: string, prompt: string, answer: string, timestamp: string) =>
      `${[
        { type: "session", version: 1, id, timestamp, cwd },
        { type: "message", id: `${id}-user`, parentId: null, timestamp, message: { role: "user", content: [{ type: "text", text: prompt }], timestamp: 1 } },
        { type: "message", id: `${id}-assistant`, parentId: `${id}-user`, timestamp, message: { role: "assistant", content: [{ type: "text", text: answer }], provider: "openrouter", model: "openai/gpt-4o-mini", timestamp: 1 } },
        { type: "session_info", id: `${id}-info`, parentId: `${id}-assistant`, timestamp, name },
      ].map((entry) => JSON.stringify(entry)).join("\n")}\n`;

    await adapter.write(
      `${sessionsDir}/2026-06-25T00-00-00-000Z_mobile-alpha.jsonl`,
      session("mobile-alpha", "Mobile Alpha", "alpha prompt", "alpha answer", "2026-06-25T00:00:00.000Z"),
    );
    await adapter.write(
      `${sessionsDir}/2026-06-25T00-01-00-000Z_mobile-beta.jsonl`,
      session("mobile-beta", "Mobile Beta", "beta prompt", "beta answer", "2026-06-25T00:01:00.000Z"),
    );

    // Seed one agent plugin package so the Advanced tab renders a real
    // installed-plugin row and the narrow-viewport row layout is exercised.
    const pluginRoot = ".agentic-plugins/mobile-demo";
    const ensureDirs = async (rel: string[]) => {
      let current = "";
      for (const segment of rel) {
        current = current ? `${current}/${segment}` : segment;
        if (!(await adapter.exists(current))) await adapter.mkdir(current);
      }
    };
    await ensureDirs(pluginRoot.split("/"));
    const pluginFiles = [
      ["plugin.json", JSON.stringify({
        $schema: "https://agent-plugins.dev/schema/v1.0.0/plugin.schema.json",
        name: "mobile-demo",
        version: "1.0.0",
        description: "Mobile viewport row-layout sample",
      }, null, 2) + "\n"],
      ["skills/hello/SKILL.md", "---\nname: hello\ndescription: Sample skill for the mobile demo package.\n---\n# Hello\n\nA tiny sample skill.\n"],
    ];
    const skillParent = `${pluginRoot}/skills/hello`;
    await ensureDirs(skillParent.split("/"));
    for (const [rel, content] of pluginFiles) {
      await adapter.write(`${pluginRoot}/${rel}`, content);
    }
  }, MOBILE_WRITE_PATH);
}

async function assertFits(rootSelector: string, label: string): Promise<void> {
  const result = await browser.execute((selector) => {
    const root = document.querySelector<HTMLElement>(selector);
    if (!root) return { missing: selector, offenders: [] as string[], root: null };
    const rootRect = root.getBoundingClientRect();
    const offenders: string[] = [];
    const elements = [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))];
    for (const element of elements) {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      if (rect.width === 0 || rect.height === 0 || style.display === "none" || style.visibility === "hidden") continue;
      if (rect.left < rootRect.left - 2 || rect.right > rootRect.right + 2) {
        offenders.push(`${element.className || element.tagName} ${Math.round(rect.width)}w scroll=${element.scrollWidth}/${element.clientWidth}`);
      }
    }
    return {
      missing: "",
      offenders: offenders.slice(0, 8),
      root: {
        width: Math.round(rootRect.width),
        scrollWidth: root.scrollWidth,
        clientWidth: root.clientWidth,
      },
    };
  }, rootSelector);

  if (result.missing) throw new Error(`${label} root ${result.missing} was not found`);
  if (result.root && result.root.scrollWidth > result.root.clientWidth + 2) {
    throw new Error(`${label} root overflows horizontally: ${JSON.stringify(result.root)}`);
  }
  if (result.offenders.length > 0) throw new Error(`${label} has horizontal overflow: ${result.offenders.join("; ")}`);
}

type HeadingRowMetrics = {
  missing: boolean;
  isPhone: boolean;
  hasClass: boolean;
  headerWidth: number;
  headerRight: number;
  infoWidth: number;
  nameWidth: number;
  nameHeight: number;
  controlWidth: number;
  controlRight: number;
  controlCenters: number[];
  buttonWidths: number[];
  bodyOverflow: boolean;
};

/** Measure the rendered geometry of a named settings heading row. */
async function measureHeadingRow(name: string): Promise<HeadingRowMetrics> {
  return await browser.execute((rowName) => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>(".agentic-chat-settings-tabbody .setting-item:not(.agentic-chat-settings-block)"));
    const header = rows.find(
      (row) => row.querySelector<HTMLElement>(".setting-item-name")?.innerText.trim() === rowName,
    );
    const body = document.querySelector<HTMLElement>(".agentic-chat-settings-tabbody");
    if (!header) {
      return {
        missing: true,
        isPhone: document.body.classList.contains("is-phone"),
        hasClass: false,
        headerWidth: 0,
        headerRight: 0,
        infoWidth: 0,
        nameWidth: 0,
        nameHeight: 0,
        controlWidth: 0,
        controlRight: 0,
        controlCenters: [],
        buttonWidths: [],
        bodyOverflow: false,
      };
    }

    const box = (element: Element | null): DOMRect | null => element?.getBoundingClientRect() ?? null;
    const info = box(header.querySelector(".setting-item-info"));
    const nameEl = box(header.querySelector(".setting-item-name"));
    const control = header.querySelector<HTMLElement>(".setting-item-control");
    const controlBox = box(control);
    const headerBox = box(header);
    return {
      missing: false,
      isPhone: document.body.classList.contains("is-phone"),
      hasClass: header.classList.contains("agentic-chat-setting-heading-wrap"),
      headerWidth: Math.round(headerBox?.width ?? 0),
      headerRight: Math.round(headerBox?.right ?? 0),
      infoWidth: Math.round(info?.width ?? 0),
      nameWidth: Math.round(nameEl?.width ?? 0),
      nameHeight: Math.round(nameEl?.height ?? 0),
      controlWidth: Math.round(controlBox?.width ?? 0),
      controlRight: Math.round(controlBox?.right ?? 0),
      controlCenters: Array.from(control?.children ?? []).map((child) => {
        const rect = child.getBoundingClientRect();
        return Math.round(rect.top + rect.height / 2);
      }),
      buttonWidths: Array.from(control?.querySelectorAll<HTMLButtonElement>("button") ?? []).map((button) =>
        Math.round(button.getBoundingClientRect().width),
      ),
      bodyOverflow: body ? body.scrollWidth > body.clientWidth + 2 : false,
    };
  }, name);
}

/** Assert a heading row keeps its text readable and its controls aligned and contained. */
function assertHeadingRowReadable(metrics: HeadingRowMetrics, label: string): void {
  if (metrics.missing) throw new Error(`${label} did not render`);
  expect(metrics.isPhone).toBe(true);
  expect(metrics.hasClass).toBe(true);
  expect(metrics.headerWidth).toBeGreaterThan(250);
  // Before the wrap fix the info column collapsed to a few pixels and the name
  // wrapped one character per line.
  expect(metrics.infoWidth).toBeGreaterThanOrEqual(Math.round(metrics.headerWidth * 0.5));
  expect(metrics.nameWidth).toBeGreaterThanOrEqual(Math.round(metrics.headerWidth * 0.35));
  expect(metrics.nameHeight).toBeLessThan(48);
  expect(metrics.controlRight).toBeLessThanOrEqual(metrics.headerRight + 1);
  expect(metrics.bodyOverflow).toBe(false);
  // The phone override must keep buttons at their natural width instead of
  // stretching each one to the full control width.
  expect(metrics.buttonWidths.length).toBeGreaterThanOrEqual(1);
  for (const width of metrics.buttonWidths) {
    expect(width).toBeLessThanOrEqual(Math.round(metrics.headerWidth * 0.6));
  }
  // Toggle and buttons share one row when they fit.
  if (metrics.controlCenters.length > 1) {
    expect(Math.max(...metrics.controlCenters) - Math.min(...metrics.controlCenters)).toBeLessThanOrEqual(2);
  }
}

async function allowApproval(): Promise<void> {
  const card = await $('[data-ac="approval"]:not(.is-resolved)');
  await card.waitForExist({ timeout: 10_000 });
  await expect(card.$('[data-ac="approval-allow"]')).toBeDisplayed();
  await expect(card.$('[data-ac="approval-deny"]')).toBeDisplayed();
  await assertFits('[data-ac="approval"]:not(.is-resolved)', "approval card");
  await card.$('[data-ac="approval-allow"]').click();
  await card.waitForExist({ reverse: true, timeout: 5_000 });
}

async function noteExists(path: string): Promise<boolean> {
  return await browser.executeObsidian(async ({ app }, notePath) => app.vault.getAbstractFileByPath(notePath) != null, path);
}

describe("agentic-chat mobile viewport", function () {
  before(async function () {
    await setMobileViewport();
    await seedMobileState();
    await installScriptedTurns([
      toolTurn("mobile approval write", "mobile-write", "write", {
        path: MOBILE_WRITE_PATH,
        content: MOBILE_WRITE_BODY,
      }),
      textTurn("mobile approval final", "Wrote the mobile approval note."),
      toolTurn("mobile big approval write", "mobile-big-write", "write", {
        path: MOBILE_BIG_WRITE_PATH,
        content: Array.from({ length: 200 }, (_, index) => `line ${index + 1} of a long note body`).join("\n"),
      }),
      textTurn("mobile big approval final", "Wrote the long note."),
      textTurn(
        "mobile long response",
        `MobileWrap ${Array.from({ length: 30 }, (_, index) => `long-mobile-response-token-${index + 1}`).join("-")}`,
      ),
    ]);
    await openChat();
  });

  after(async function () {
    await closeOpenModals();
  });

  it("keeps the chat composer and toolbar usable at phone width", async function () {
    await expect($('[data-ac="composer-input"]')).toBeDisplayed();
    await expect($('[data-ac="send"]')).toBeDisplayed();
    await expect($('[data-ac="mode-toggle"]')).toBeDisplayed();
    await assertFits('[data-ac="view"]', "chat view");
    await assertFits('[data-ac="composer-card"]', "composer field");
    await expectWithinWindow(COMPOSER_PARTS);
  });

  it("lifts the composer above the keyboard in the sidebar drawer (U7 #1)", async function () {
    // On a phone the app container shrinks above the keyboard but the drawer does not.
    // Emulate that: shrink .app-container by 300px and check the composer ends above its
    // bottom (the keyboard top), without a big gap.
    const gap = await browser.execute(async () => {
      const app = document.querySelector<HTMLElement>(".app-container");
      const before = app?.style.height ?? "";
      if (app) app.style.height = `${app.getBoundingClientRect().height - 300}px`;
      await new Promise((resolve) => setTimeout(resolve, 600));
      const card = document.querySelector<HTMLElement>('[data-ac="composer-card"]')?.getBoundingClientRect();
      const appBottom = app?.getBoundingClientRect().bottom ?? -1;
      const inDrawer = Boolean(document.querySelector('.workspace-drawer [data-ac="view"]'));
      const room = card ? appBottom - card.bottom : -999;
      if (app) app.style.height = before;
      return { room, inDrawer };
    });
    expect(gap.inDrawer).toBe(true);
    expect(gap.room).toBeGreaterThanOrEqual(0);
    expect(gap.room).toBeLessThanOrEqual(40);
  });

  it("keeps the settings tab UI usable at phone width", async function () {
    await openAgenticChatSettings();
    await selectSettingsTab("Models");
    await waitForSetting("Model provider");
    await selectSettingsTab("Advanced");
    await waitForSetting("Enable MCP");
    await waitForSetting("Mobile MCP Demo");
    assertHeadingRowReadable(await measureHeadingRow("Mobile MCP Demo"), "MCP server header");
    // U7 #8 and #6: each server is a card; its Advanced fold starts closed.
    const card = await browser.execute(() => {
      const el = document.querySelector<HTMLElement>(".agentic-chat-mcp-card");
      const fold = el?.querySelector<HTMLDetailsElement>("details.agentic-chat-mcp-advanced");
      const rect = el?.getBoundingClientRect();
      const border = el ? getComputedStyle(el).borderTopWidth : "0px";
      const body = document.querySelector<HTMLElement>(".agentic-chat-settings-tabbody");
      return {
        exists: Boolean(el),
        foldClosed: fold ? !fold.open : false,
        width: rect ? Math.round(rect.width) : 0,
        right: rect ? Math.round(rect.right) : 0,
        bodyRight: body ? Math.round(body.getBoundingClientRect().right) : 0,
        border: Number.parseFloat(border),
      };
    });
    expect(card.exists).toBe(true);
    expect(card.foldClosed).toBe(true);
    expect(card.border).toBeGreaterThan(0);
    expect(card.right).toBeLessThanOrEqual(card.bodyRight + 1);
    await openMcpAdvancedFolds();
    await waitForSetting("Tool approvals");
    assertHeadingRowReadable(await measureHeadingRow("Tool approvals"), "Tool approvals heading");
    await assertFits(".agentic-chat-settings-tabbody", "MCP settings body");
    await selectSettingsTab("Agent");
    await waitForSetting("Per-tool overrides");
    await assertFits(".agentic-chat-settings-tabbody", "Agent settings body");
    await selectSettingsTab("Advanced");
    await waitForSetting("Plugins folder");
    // The seeded agent plugin must render an installed-plugin row so the
    // narrow-viewport row layout (title + controls) is actually exercised.
    await browser.waitUntil(
      async () =>
        await browser.execute(() =>
          document.querySelector(".agentic-chat-settings-tabbody")?.textContent?.includes("mobile-demo") ?? false,
        ),
      { timeout: 10_000, timeoutMsg: "seeded agent plugin row did not render in Advanced at phone width" },
    );
    // U7 #9: the path wrapped one letter per line because the controls took the row.
    const meta = await browser.execute(() => {
      // The path span is the first child of the meta line; extra lines (reports) follow it.
      const el = document.querySelector<HTMLElement>(".agentic-chat-plugin-meta > span");
      const rect = el?.getBoundingClientRect();
      const style = el ? getComputedStyle(el) : null;
      const line = Number.parseFloat(style?.lineHeight ?? "") || Number.parseFloat(style?.fontSize ?? "") * 1.4 || 16;
      return { width: rect ? Math.round(rect.width) : 0, lines: rect ? Math.round(rect.height / line) : 99 };
    });
    expect(meta.width).toBeGreaterThan(200);
    expect(meta.lines).toBeLessThanOrEqual(4);
    await assertFits(".setting-page-content", "settings tabs");
    await assertFits(".agentic-chat-settings-tabbody", "settings body");
    await closeAgenticChatSettings();
    await openChat();
  });

  it("keeps the approval card visible and touchable at phone width", async function () {
    await sendPrompt("mobile approval write");
    await allowApproval();
    await browser.waitUntil(async () => await noteExists(MOBILE_WRITE_PATH), {
      timeout: 10_000,
      timeoutMsg: "mobile approval write did not create the note",
    });
  });

  it("keeps Allow and Deny on screen for a tall approval card (U7 #3)", async function () {
    await sendPrompt("mobile big approval write");
    const card = await $('[data-ac="approval"]:not(.is-resolved)');
    await card.waitForExist({ timeout: 10_000 });
    await expectWithinWindow(['[data-ac="approval-allow"]', '[data-ac="approval-deny"]']);
    // expectWithinWindow checks only the horizontal axis; check the vertical one too.
    const vertical = await browser.execute(() =>
      ['[data-ac="approval-allow"]', '[data-ac="approval-deny"]'].map((selector) => {
        const rect = document.querySelector<HTMLElement>(`[data-ac="approval"]:not(.is-resolved) ${selector}`)?.getBoundingClientRect();
        return rect ? { top: rect.top, bottom: rect.bottom, inner: window.innerHeight } : null;
      }),
    );
    for (const rect of vertical) {
      expect(rect).not.toBeNull();
      expect(rect!.top).toBeGreaterThanOrEqual(0);
      expect(rect!.bottom).toBeLessThanOrEqual(rect!.inner);
    }
    const height = await browser.execute(
      () => document.querySelector<HTMLElement>('[data-ac="approval"]:not(.is-resolved)')?.getBoundingClientRect().height ?? 0,
    );
    expect(height).toBeLessThanOrEqual(530);
    await card.$('[data-ac="approval-allow"]').click();
    await card.waitForExist({ reverse: true, timeout: 5_000 });
  });

  it("keeps the session history modal usable at phone width", async function () {
    await runSlashCommand("/sessions");
    await $(".agentic-chat-session-list").waitForExist();
    await expect($(".agentic-chat-session-row")).toBeDisplayed();
    await assertFits(".modal-container .modal", "session modal");
    await assertFits(".agentic-chat-session-list", "session list");
    await closeOpenModals();
  });

  it("keeps the composer above the floating navbar when the chat is in the main area", async function () {
    await browser.executeObsidian(async ({ app }, viewType) => {
      const leaf = app.workspace.getLeaf(true);
      await leaf.setViewState({ type: viewType, active: true });
    }, VIEW_TYPE_AGENT_CHAT);
    await browser.waitUntil(
      async () => await browser.execute(() => !!document.querySelector('.mod-root [data-ac="view"] [data-ac="composer-card"]')),
      { timeout: 10_000, timeoutMsg: "no chat view in the main area" },
    );
    await browser.pause(500);
    const layout = await browser.execute(() => {
      const card = document.querySelector<HTMLElement>('.mod-root [data-ac="view"] [data-ac="composer-card"]')?.getBoundingClientRect();
      const navbar = document.querySelector<HTMLElement>(".mobile-navbar")?.getBoundingClientRect();
      return { cardBottom: card?.bottom ?? 0, navbarTop: navbar && navbar.height > 0 ? navbar.top : null };
    });
    // Close above the navbar, as in the design: no dead band between them.
    if (layout.navbarTop !== null) expect(layout.navbarTop - layout.cardBottom).toBeLessThanOrEqual(16);
    // Obsidian hides the navbar while scrolling ("auto full screen"): the
    // composer takes the freed space back (CSS only, no redraw).
    const hidden = await browser.execute(async () => {
      document.body.classList.add("is-hidden-nav");
      await new Promise((resolve) => setTimeout(resolve, 400));
      const view = document.querySelector<HTMLElement>('.mod-root [data-ac="view"]');
      const card = view?.querySelector<HTMLElement>('[data-ac="composer-card"]')?.getBoundingClientRect();
      const safe = Number.parseFloat(getComputedStyle(document.body).getPropertyValue("--safe-area-inset-bottom")) || 0;
      const room = (view?.getBoundingClientRect().bottom ?? 0) - (card?.bottom ?? 0) - safe;
      document.body.classList.remove("is-hidden-nav");
      return room;
    });
    expect(hidden).toBeLessThanOrEqual(16);
    if (layout.navbarTop !== null) expect(layout.cardBottom).toBeLessThanOrEqual(layout.navbarTop);
    await browser.executeObsidian(({ app }, viewType) => {
      const leaves = app.workspace.getLeavesOfType(viewType);
      for (const leaf of leaves) if (leaf.getRoot() === app.workspace.rootSplit) leaf.detach();
    }, VIEW_TYPE_AGENT_CHAT);
    // Detaching the main-area leaf leaves no visible chat; later tests type
    // into the sidebar chat, so reveal it again.
    await openChat();
  });

  it("wraps long assistant output without horizontal overflow", async function () {
    await sendPrompt("mobile long response");
    await browser.waitUntil(
      async () =>
        await browser.execute(() => {
          const texts = Array.from(document.querySelectorAll<HTMLElement>('[data-ac="assistant-text"]'));
          return texts.some((text) => text.innerText.includes("MobileWrap"));
        }),
      { timeout: 10_000, timeoutMsg: "mobile long response did not render" },
    );
    await assertFits('[data-ac="messages"]', "message list");
    // After a transcript, the composer must still be inside the window.
    await expectWithinWindow(COMPOSER_PARTS);
    await browser.executeObsidian(async ({ app }, viewType) => {
      const view = app.workspace.getLeavesOfType(viewType)[0]?.view as unknown as {
        service?: { abort?: () => void };
      };
      view?.service?.abort?.();
    }, VIEW_TYPE_AGENT_CHAT);
  });
});
