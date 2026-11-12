import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { $, browser } from "@wdio/globals";
import { assertChaosModel, decideStop, redactSecrets, type ChaosPlan } from "../../../scripts/chaos/monkey-core";
import {
  BUILTIN_CHARTERS,
  actionRef,
  explorerSystemPrompt,
  explorerUserPrompt,
  formatObservation,
  loopVerdict,
  parseExplorerDecision,
  parseKeyChord,
  refWindow,
  resolveReplayRef,
  summarizeDecision,
  sumSessionUsage,
  targetOf,
  type ChatState,
  type ElementTarget,
  type ExplorerDecision,
  type Observation,
  type StepRecord,
  type UiElement,
  type WindowObservation,
} from "../../../scripts/chaos/explorer-core";
import { chatComplete } from "../../../scripts/chaos/explorer-llm";
import { DriverHang, withHangTimeout } from "../../../scripts/chaos/hang-timeout";
import { llmHeaders } from "../../../scripts/chaos/llm-provider";
import { mark } from "../support/record";
import { openAgenticChatSettings } from "../support/settings-ui";
import { configurePlugin, openChat } from "../probe/support/probe-helpers";

/**
 * Open-ended explorer for `npm run chaos -- --mode explore`.
 *
 * Each step: observe every window, ask the explorer model for one action (or
 * take the next recorded one in replay), perform it, then run the oracles. The
 * explorer never sees the API key, and the driver restores protected settings.
 */

export type ExplorerFinding = { severity: "S1" | "S2" | "S3" | "S4"; step: string; message: string; source: string };

export type ExplorerStep = { id: string; surface: string; status: "passed" | "failed"; detail?: string };

export type ExplorerOutcome = {
  stopReason: string;
  steps: ExplorerStep[];
  findings: ExplorerFinding[];
  calls: number;
  tokens: number;
  explorer: {
    charter: string;
    model: string;
    replay: boolean;
    calls: number;
    tokens: number;
    cost: number;
    invalidReplies: number;
    summary?: string;
  };
  plugin: { tokens: number; cost: number; assistantMessages: number; models: string[] };
};

export type ExplorerContext = {
  plan: ChaosPlan;
  apiKey?: string;
  outDir?: string;
  startedAt: number;
  scenarioNames: string[];
  /** Runs one scripted scenario; returns the failure message, or undefined on pass. */
  runScenario: (name: string) => Promise<string | undefined>;
  sessionDir: () => Promise<string>;
  assertSessionsValid: () => Promise<{ files: number; lines: number }>;
};

type RecordedDecision = { step: number; decision: ExplorerDecision; target?: ElementTarget };

const PLUGIN_ID = "agentic-chat";
const HISTORY_LIMIT = 14;
const STUCK_TURN_MS = 240_000;
/** An observation reads the DOM only; past this Obsidian is not answering. */
const OBSERVE_TIMEOUT_MS = 90_000;
/** Longest action: a 180 s turn wait, plus slack. "wait" adds its own seconds. */
const PERFORM_TIMEOUT_MS = 240_000;

const MAX_CONSECUTIVE_FAILURES = 6;
const MAX_INVALID_REPLIES = 4;
const PROTECTED_KEY = /provider|model|baseurl|apikey/i;

// ---------------------------------------------------------------------------
// Windows

let mainHandle = "";
const windowIndex = new Map<string, number>();

async function handles(): Promise<Array<{ handle: string; index: number }>> {
  const all = await browser.getWindowHandles();
  for (const handle of all) {
    if (!windowIndex.has(handle)) windowIndex.set(handle, handle === mainHandle ? 0 : windowIndex.size + 1);
  }
  for (const handle of [...windowIndex.keys()]) if (!all.includes(handle)) windowIndex.delete(handle);
  return all.map((handle) => ({ handle, index: windowIndex.get(handle) ?? 99 })).sort((a, b) => a.index - b.index);
}

async function handleFor(index: number): Promise<string> {
  const entry = (await handles()).find((candidate) => candidate.index === index);
  if (!entry) throw new Error(`window ${index} is not open`);
  return entry.handle;
}

/**
 * Switch only when the target differs. In Electron a switch can fire blur and
 * focus events, and inputs that commit on blur (for example the session rename
 * field) close before the next action can type into them.
 */
async function switchTo(handle: string): Promise<void> {
  if ((await browser.getWindowHandle().catch(() => "")) !== handle) await browser.switchToWindow(handle);
}

async function focusMain(): Promise<void> {
  await switchTo(mainHandle);
}

// ---------------------------------------------------------------------------
// Observation

type RawWindow = {
  title: string;
  modalTitles: string[];
  notices: string[];
  elements: Array<Omit<UiElement, "window">>;
  hidden: number;
  errors: string[];
  chat?: ChatState;
  stats: Record<string, number>;
};

/**
 * Collect visible interactive elements in the current window and tag each one
 * with `data-chaos-ref`. Runs in the renderer, so it must be self-contained.
 */
function collectWindow(windowNumber: number, limit: number): RawWindow {
  type ChaosWindow = Window & { __CHAOS_ERRORS__?: string[]; __CHAOS_HOOKED__?: boolean };
  const target = window as ChaosWindow;
  if (!target.__CHAOS_HOOKED__) {
    target.__CHAOS_HOOKED__ = true;
    target.__CHAOS_ERRORS__ = [];
    const push = (text: string): void => {
      const list = target.__CHAOS_ERRORS__ ?? [];
      if (list.length < 200) list.push(text.slice(0, 500));
      target.__CHAOS_ERRORS__ = list;
    };
    const original = console.error.bind(console);
    console.error = (...args: unknown[]) => {
      push(`console.error: ${args.map((arg) => (arg instanceof Error ? arg.stack ?? arg.message : String(arg))).join(" ")}`);
      original(...args);
    };
    window.addEventListener("error", (event) => push(`uncaught: ${event.message} @ ${event.filename}:${event.lineno}`));
    window.addEventListener("unhandledrejection", (event) => {
      const reason = event.reason as unknown;
      push(`unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
    });
  }
  const errors = target.__CHAOS_ERRORS__ ?? [];
  target.__CHAOS_ERRORS__ = [];

  for (const element of Array.from(document.querySelectorAll("[data-chaos-ref]"))) {
    element.removeAttribute("data-chaos-ref");
  }

  const selector = [
    "button",
    "a[href]",
    "input:not([type=hidden])",
    "textarea",
    "select",
    "summary",
    "[role=button]",
    "[role=tab]",
    "[role=menuitem]",
    "[role=checkbox]",
    "[role=switch]",
    "[role=option]",
    "[contenteditable=true]",
    ".clickable-icon",
    ".checkbox-container",
    ".vertical-tab-nav-item",
    ".menu-item",
    ".suggestion-item",
    ".agentic-chat-autocomplete-item",
    ".setting-item.mod-navigable",
    ".setting-page-back-button",
    ".nav-file-title",
    ".nav-folder-title",
    ".workspace-tab-header",
    ".dropdown",
  ].join(",");

  const regionOf = (element: Element): string => {
    if (element.closest(".vertical-tab-content-container, .vertical-tab-content")) return "settings";
    if (element.closest(".vertical-tab-header")) return "settings-nav";
    if (element.closest(".modal-container, .modal")) return "modal";
    if (element.closest(".menu")) return "menu";
    if (element.closest(".suggestion-container, .prompt, .agentic-chat-autocomplete")) return "suggest";
    if (element.closest(".agentic-chat-view")) return "chat";
    if (element.closest(".vertical-tab-content-container, .vertical-tab-content")) return "settings";
    if (element.closest(".vertical-tab-header")) return "settings-nav";
    if (element.closest(".cm-editor, .markdown-source-view, .markdown-reading-view")) return "editor";
    if (element.closest(".workspace-tab-header-container")) return "tabs";
    if (element.closest(".nav-files-container, .workspace-leaf-content[data-type=file-explorer]")) return "files";
    if (element.closest(".workspace-ribbon, .side-dock-ribbon")) return "ribbon";
    return "other";
  };
  const order = ["modal", "menu", "suggest", "settings", "settings-nav", "chat", "editor", "tabs", "files", "ribbon", "other"];

  const visible = (element: HTMLElement): boolean => {
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    if (rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth) return false;
    const style = window.getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0.05;
  };
  const flat = (text: string | null | undefined): string => (text ?? "").replace(/\s+/g, " ").trim();

  // Fallback: plugin and overlay elements that only show a pointer cursor are
  // clickable too (custom rows, chips, cards). Limit the scan to those roots.
  const pointerRoots =
    ".agentic-chat-view *, .modal-container *, .menu *, .agentic-chat-autocomplete *, .vertical-tab-content *";
  const explicit = new Set(Array.from(document.querySelectorAll<HTMLElement>(selector)));
  for (const element of Array.from(document.querySelectorAll<HTMLElement>(pointerRoots))) {
    if (explicit.has(element) || element.closest(selector)) continue;
    if (window.getComputedStyle(element).cursor !== "pointer") continue;
    const parent = element.parentElement;
    if (parent && window.getComputedStyle(parent).cursor === "pointer") continue;
    explicit.add(element);
  }
  const stats: Record<string, number> = { matched: explicit.size, invisible: 0, unlabeled: 0, nested: 0 };
  const candidates = Array.from(explicit).filter((element) => {
    const ok = visible(element);
    if (!ok) stats.invisible += 1;
    return ok;
  });
  const chosen = new Set<HTMLElement>();
  const items: Array<Omit<UiElement, "window" | "ref"> & { node: HTMLElement }> = [];
  for (const element of candidates) {
    // Skip a node nested in an already chosen clickable with no own label.
    const parent = element.parentElement?.closest<HTMLElement>(selector);
    const tag = element.tagName.toLowerCase();
    const input = element as HTMLInputElement;
    let role = element.getAttribute("role") ?? tag;
    if (tag === "input") role = `input:${input.type || "text"}`;
    if (element.classList.contains("checkbox-container")) role = "toggle";
    if (element.isContentEditable && tag !== "input" && tag !== "textarea") role = "editor";
    if (element.classList.contains("dropdown") || tag === "select") role = "dropdown";
    if (element.classList.contains("mod-navigable")) role = "nav-row";
    const settingName = flat(element.closest(".setting-item")?.querySelector(".setting-item-name")?.textContent);
    let label =
      (role === "nav-row" ? settingName : "") ||
      flat(element.getAttribute("aria-label")) ||
      (tag === "input" || tag === "textarea" ? flat(input.placeholder) || flat(input.name) : "") ||
      flat(element.innerText).slice(0, 90) ||
      flat(element.getAttribute("title")) ||
      flat(element.className.toString().split(" ").find((name) => name.startsWith("agentic-chat-")) ?? "");
    if (settingName && (role === "toggle" || role === "dropdown" || role.startsWith("input") || role === "textarea" || role === "button")) {
      label = label && label !== settingName ? `${settingName}: ${label}` : settingName;
    }
    if (!label) {
      stats.unlabeled += 1;
      continue;
    }
    if (parent && chosen.has(parent) && flat(parent.innerText).includes(label)) {
      stats.nested += 1;
      continue;
    }
    chosen.add(element);
    let value: string | undefined;
    if (tag === "input" || tag === "textarea" || tag === "select") value = flat((element as HTMLInputElement).value).slice(0, 80);
    else if (role === "editor") value = flat(element.innerText).slice(0, 80);
    const checked =
      role === "toggle"
        ? element.classList.contains("is-enabled")
        : tag === "input" && (input.type === "checkbox" || input.type === "radio")
          ? input.checked
          : undefined;
    items.push({
      node: element,
      region: regionOf(element) as UiElement["region"],
      role,
      label,
      value: value || undefined,
      checked,
      disabled: (element as HTMLButtonElement).disabled === true || element.getAttribute("aria-disabled") === "true",
    });
  }
  items.sort((a, b) => order.indexOf(a.region) - order.indexOf(b.region));
  const kept = items.slice(0, limit);
  const elements = kept.map((item, index) => {
    const ref = `w${windowNumber}e${index + 1}`;
    item.node.setAttribute("data-chaos-ref", ref);
    const { node, ...rest } = item;
    void node;
    return { ref, ...rest };
  });

  let chat: ChatState | undefined;
  const view = document.querySelector<HTMLElement>(".agentic-chat-view");
  if (view) {
    const stop = view.querySelector<HTMLElement>(".agentic-chat-stop");
    const messagesEl = view.querySelector<HTMLElement>(".agentic-chat-messages");
    const messages = Array.from(view.querySelectorAll<HTMLElement>(".agentic-chat-message, .agentic-chat-info"))
      .slice(-4)
      .map((element) => ({
        role: (element.classList.contains("agentic-chat-user")
          ? "user"
          : element.classList.contains("agentic-chat-assistant")
            ? "assistant"
            : "info") as "user" | "assistant" | "info",
        text: flat(element.innerText).slice(0, 600),
      }));
    chat = {
      open: true,
      running: Boolean(stop && stop.offsetParent !== null),
      composer: flat(view.querySelector<HTMLTextAreaElement>(".agentic-chat-input")?.value).slice(0, 200),
      errorPanels: view.querySelectorAll(".agentic-chat-info-error, .agentic-chat-error").length,
      approvalOpen: Boolean(document.querySelector(".agentic-chat-approval")),
      overflowX: Boolean(messagesEl && messagesEl.scrollWidth > messagesEl.clientWidth + 2),
      lastMessages: messages,
    };
  }

  return {
    title: document.title,
    modalTitles: Array.from(document.querySelectorAll<HTMLElement>(".modal-title")).map((el) => flat(el.innerText)).filter(Boolean),
    notices: Array.from(document.querySelectorAll<HTMLElement>(".notice")).map((el) => flat(el.innerText)).filter(Boolean),
    elements,
    hidden: Math.max(0, items.length - kept.length),
    errors,
    chat,
    stats: { ...stats, settingItems: document.querySelectorAll(".setting-item").length },
  };
}

async function observe(
  step: number,
  budget: Observation["budget"],
  signals: string[],
): Promise<{ observation: Observation; errors: string[]; stats: Record<string, Record<string, number>> }> {
  const windows: WindowObservation[] = [];
  const errors: string[] = [];
  const stats: Record<string, Record<string, number>> = {};
  let chat: ChatState = {
    open: false,
    running: false,
    composer: "",
    errorPanels: 0,
    approvalOpen: false,
    overflowX: false,
    lastMessages: [],
  };
  // Read non-current windows first and the current one last, so the driver
  // ends on the window that had focus and does not blur its inputs twice.
  const current = await browser.getWindowHandle().catch(() => mainHandle);
  const ordered = (await handles()).sort((a, b) => Number(a.handle === current) - Number(b.handle === current));
  for (const { handle, index } of ordered) {
    try {
      await switchTo(handle);
      const raw = (await browser.execute(collectWindow, index, index === 0 ? 140 : 90)) as RawWindow;
      windows.push({
        index,
        title: raw.title,
        modalTitles: raw.modalTitles,
        notices: raw.notices,
        // WebDriver turns undefined into null; normalize so a button is not read as "off".
        elements: raw.elements.map((element) => ({
          ...element,
          window: index,
          value: element.value ?? undefined,
          checked: typeof element.checked === "boolean" ? element.checked : undefined,
          disabled: element.disabled === true ? true : undefined,
        })),
        hidden: raw.hidden,
      });
      errors.push(...raw.errors.map((error) => `w${index} ${error}`));
      stats[`w${index}`] = raw.stats;
      if (raw.chat) chat = raw.chat;
    } catch (error) {
      signals.push(`could not read window ${index}: ${message(error)}`);
    }
  }
  windows.sort((a, b) => a.index - b.index);
  // executeObsidian needs the main window; come back to the focused window after.
  await focusMain();
  const vault = (await browser
    .executeObsidian(({ app }) => ({
      active: app.workspace.getActiveFile()?.path,
      files: app.vault
        .getFiles()
        .map((file) => file.path)
        .sort()
        .slice(0, 40),
    }))
    .catch(() => ({ active: undefined, files: [] as string[] }))) as { active?: string; files: string[] };
  return {
    observation: {
      step,
      windows,
      chat,
      activeFile: vault.active,
      vaultFiles: vault.files,
      errors,
      signals: [...signals],
      budget,
    },
    errors,
    stats,
  };
}

// ---------------------------------------------------------------------------
// Actions

async function elementFor(ref: string): Promise<WebdriverIO.Element> {
  await switchTo(await handleFor(refWindow(ref)));
  const element = await $(`[data-chaos-ref="${ref}"]`);
  if (!(await element.isExisting())) throw new Error(`ref ${ref} is gone; the view changed`);
  return element;
}

async function chatRunning(): Promise<boolean> {
  await focusMain();
  return await browser.execute(() => {
    const stop = document.querySelector<HTMLElement>(".agentic-chat-stop");
    return Boolean(stop && stop.offsetParent !== null);
  });
}

async function waitForTurn(maxMs: number): Promise<string> {
  const deadline = Date.now() + maxMs;
  await browser.pause(400);
  while (Date.now() < deadline) {
    if (!(await chatRunning())) return "turn finished";
    if (await $(".agentic-chat-approval").isExisting()) return "approval requested";
    await browser.pause(700);
  }
  return `turn still running after ${Math.round(maxMs / 1000)}s`;
}

async function perform(
  decision: ExplorerDecision,
  context: ExplorerContext,
  secondsLeft: () => number,
): Promise<string> {
  switch (decision.action) {
    case "click": {
      const element = await elementFor(decision.ref);
      try {
        await element.click();
      } catch {
        await browser.execute((el) => (el as unknown as HTMLElement).click(), element);
      }
      await browser.pause(400);
      return "clicked";
    }
    case "type": {
      const element = await elementFor(decision.ref);
      const editable = await element.getAttribute("contenteditable");
      if (editable === "true") {
        await element.click().catch(() => undefined);
        await browser.keys(["Control", "a"]);
        await browser.keys(decision.text ? decision.text.split("") : ["Backspace"]);
      } else {
        // Focus and select by script, then type real keys. Not setValue: its
        // WebDriver "Element Clear" blurs the field, and a field that commits on
        // blur (the session rename input) closes before the text arrives. Not
        // a click: it can hit a parent row that re-renders.
        const ready = await browser.execute((ref) => {
          const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-chaos-ref="${ref}"]`);
          if (!field) return false;
          field.focus();
          field.select();
          return document.activeElement === field;
        }, decision.ref);
        if (!ready) throw new Error(`ref ${decision.ref} could not take focus`);
        await browser.keys(decision.text ? decision.text.split("") : ["Backspace"]);
      }
      if (decision.submit) await browser.keys("Enter");
      await browser.pause(400);
      return decision.submit ? "typed and pressed Enter" : "typed";
    }
    case "key": {
      const keys = parseKeyChord(decision.keys);
      await switchTo(await handleFor(decision.window ?? 0));
      await browser.keys(keys);
      await browser.pause(400);
      return `pressed ${keys.join("+")}`;
    }
    case "scroll": {
      const element = await elementFor(decision.ref);
      await browser.execute(
        (el, dy) => {
          let node: HTMLElement | null = el as unknown as HTMLElement;
          while (node && node.scrollHeight <= node.clientHeight + 1) node = node.parentElement;
          (node ?? document.scrollingElement)?.scrollBy({ top: dy });
        },
        element,
        decision.dy,
      );
      await browser.pause(250);
      return "scrolled";
    }
    case "command": {
      await focusMain();
      const known = await browser.executeObsidian(({ app }, id) => {
        const commands = (app as unknown as { commands: { commands: Record<string, unknown> } }).commands.commands;
        return Boolean(commands[id]);
      }, decision.id);
      if (!known) throw new Error(`unknown command id ${decision.id}`);
      await browser.executeObsidianCommand(decision.id);
      await browser.pause(600);
      return "command ran";
    }
    case "send": {
      await focusMain();
      if (!(await $(".agentic-chat-input").isExisting())) await openChat();
      const input = $(".agentic-chat-input");
      await input.click();
      await input.setValue(decision.text);
      await browser.keys("Enter");
      if (decision.wait === false) {
        await browser.pause(600);
        return "sent without waiting";
      }
      return `sent; ${await waitForTurn(Math.max(10_000, Math.min(180_000, (secondsLeft() + 30) * 1000)))}`;
    }
    case "wait":
      await browser.pause(decision.seconds * 1000);
      return `waited ${decision.seconds}s`;
    case "resize": {
      await focusMain();
      const size = context.plan.size ?? { width: 1440, height: 1000 };
      const width = Math.max(320, Math.min(size.width, decision.width));
      const height = Math.max(400, Math.min(size.height, decision.height));
      // Try the Electron window first: chromedriver's resize needs
      // Browser.getWindowForTarget, which this Electron build does not have.
      const via = await browser.execute(
        (w, h) => {
          type Win = { setSize?: (w: number, h: number) => void };
          const req = (window as unknown as { require?: (id: string) => unknown }).require;
          const candidates: Array<[string, () => Win | undefined]> = [
            ["electronWindow", () => (window as unknown as { electronWindow?: Win }).electronWindow],
            ["@electron/remote", () => (req?.("@electron/remote") as { getCurrentWindow?: () => Win })?.getCurrentWindow?.()],
            ["electron.remote", () => (req?.("electron") as { remote?: { getCurrentWindow?: () => Win } })?.remote?.getCurrentWindow?.()],
          ];
          for (const [name, get] of candidates) {
            try {
              const win = get();
              if (typeof win?.setSize === "function") {
                win.setSize(w, h);
                return name;
              }
            } catch {
              // try the next way
            }
          }
          return "";
        },
        width,
        height,
      );
      let method = via;
      if (!method) {
        try {
          await browser.setWindowRect(null, null, width, height);
          method = "setWindowRect";
        } catch {
          await browser.setWindowSize(width, height);
          method = "setWindowSize";
        }
      }
      await browser.pause(500);
      const actual = await browser.execute(() => ({ w: window.innerWidth, h: window.innerHeight }));
      if (Math.abs(actual.w - width) > 40) {
        throw new Error(`resize to ${width}x${height} via ${method} left the window at ${actual.w}x${actual.h}`);
      }
      return `resized to ${actual.w}x${actual.h} via ${method}`;
    }
    case "open_settings":
      await openAgenticChatSettings();
      await browser.pause(600);
      await focusMain();
      return "settings opened";
    case "close_window": {
      if (decision.window === 0) throw new Error("the main window cannot be closed");
      await switchTo(await handleFor(decision.window));
      try {
        await browser.closeWindow();
      } catch {
        await browser.execute(() => window.close());
      }
      await browser.switchToWindow(mainHandle);
      await browser.pause(400);
      return `closed window ${decision.window}`;
    }
    case "reload_plugin":
      await focusMain();
      await browser.executeObsidian(async ({ app }, id) => {
        const plugins = (app as unknown as { plugins: { disablePlugin(id: string): Promise<void>; enablePlugin(id: string): Promise<void> } }).plugins;
        await plugins.disablePlugin(id);
        await plugins.enablePlugin(id);
      }, PLUGIN_ID);
      await browser.pause(1_500);
      return "plugin reloaded";
    case "scenario": {
      if (!context.scenarioNames.includes(decision.name)) {
        throw new Error(`unknown scenario ${decision.name}; use one of ${context.scenarioNames.join(", ")}`);
      }
      await focusMain();
      const failure = await context.runScenario(decision.name);
      await focusMain();
      if (failure) throw new Error(`scenario ${decision.name} failed its checks: ${failure}`);
      return `scenario ${decision.name} passed its checks`;
    }
    case "report":
      return "reported";
    case "done":
      return "done";
  }
}

// ---------------------------------------------------------------------------
// Oracles

type Guarded = Record<string, string>;

async function readGuarded(): Promise<Guarded> {
  await focusMain();
  return (await browser.executeObsidian(({ app }, id) => {
    const plugin = (app as unknown as { plugins: { plugins: Record<string, { settings?: Record<string, unknown> }> } })
      .plugins.plugins[id];
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(plugin?.settings ?? {})) {
      if (typeof value === "string" && /provider|model|baseurl|apikey/i.test(key)) out[key] = value;
    }
    return out;
  }, PLUGIN_ID)) as Guarded;
}

/** Restore provider, model, base URL, and key fields the explorer changed. Never log values. */
async function guardSettings(expected: Guarded): Promise<string | undefined> {
  const current = await readGuarded().catch(() => undefined);
  if (!current) return undefined;
  const changed = Object.keys(expected).filter((key) => PROTECTED_KEY.test(key) && current[key] !== expected[key]);
  if (changed.length === 0) return undefined;
  await configurePlugin(Object.fromEntries(changed.map((key) => [key, expected[key]])));
  return `protected settings were changed and restored: ${changed.join(", ")}`;
}

async function sessionTexts(context: ExplorerContext): Promise<string[]> {
  const dir = await context.sessionDir().catch(() => "");
  if (!dir || !existsSync(dir)) return [];
  const files = (await readdir(dir)).filter((name) => name.endsWith(".jsonl"));
  return await Promise.all(files.map(async (file) => await readFile(path.join(dir, file), "utf8").catch(() => "")));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message.split("\n")[0] : String(error);
}

// ---------------------------------------------------------------------------
// Loop

async function loadReplay(file: string): Promise<RecordedDecision[]> {
  const text = await readFile(file, "utf8");
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RecordedDecision);
}

async function append(outDir: string | undefined, file: string, value: unknown): Promise<void> {
  if (!outDir) return;
  await mkdir(outDir, { recursive: true });
  await appendFile(path.join(outDir, file), `${JSON.stringify(value)}\n`);
}

async function pluginCommands(): Promise<string[]> {
  await focusMain();
  return (await browser.executeObsidian(({ app }, prefix) => {
    const commands = (app as unknown as { commands: { commands: Record<string, { name?: string }> } }).commands.commands;
    return Object.keys(commands)
      .filter((id) => id.startsWith(prefix))
      .sort();
  }, `${PLUGIN_ID}:`)) as string[];
}

export function resolveCharter(plan: ChaosPlan): string {
  return plan.charter?.trim() || BUILTIN_CHARTERS.broad;
}

export async function runExplorer(context: ExplorerContext): Promise<ExplorerOutcome> {
  const { plan, apiKey } = context;
  const replay = plan.replayFile ? await loadReplay(plan.replayFile) : undefined;
  if (!replay && (!plan.live || !apiKey)) throw new Error("explore mode needs --live and a key, or --replay");
  if (plan.live) assertChaosModel(plan.model, plan.allowAnyModel === true);

  mainHandle = await browser.getWindowHandle();
  windowIndex.clear();
  windowIndex.set(mainHandle, 0);
  if (plan.size) await browser.setWindowRect(0, 0, plan.size.width, plan.size.height).catch(() => undefined);

  const charter = resolveCharter(plan);
  const outcome: ExplorerOutcome = {
    stopReason: "completed",
    steps: [],
    findings: [],
    calls: 0,
    tokens: 0,
    explorer: { charter, model: plan.model, replay: Boolean(replay), calls: 0, tokens: 0, cost: 0, invalidReplies: 0 },
    plugin: { tokens: 0, cost: 0, assistantMessages: 0, models: [] },
  };
  const system = explorerSystemPrompt(context.scenarioNames, await pluginCommands().catch(() => []));
  const expected = await readGuarded();
  const history: StepRecord[] = [];
  const allSteps: StepRecord[] = [];
  const seenErrors = new Map<string, number>();
  let memory = "";
  let pendingSignals: string[] = [];
  let lastReplyError: string | undefined;
  let consecutiveFailures = 0;
  let consecutiveInvalid = 0;
  let runningSince: number | undefined;
  let replayIndex = 0;

  const secondsLeft = (): number => Math.max(0, Math.round(plan.caps.maxSeconds - (Date.now() - context.startedAt) / 1000));
  const refreshUsage = async (): Promise<void> => {
    const usage = sumSessionUsage(await sessionTexts(context));
    outcome.plugin = usage;
    outcome.tokens = outcome.explorer.tokens + usage.tokens;
    outcome.calls = outcome.explorer.calls + usage.assistantMessages;
    if (plan.live) {
      const escaped = usage.models.filter((model) => {
        try {
          assertChaosModel(model, plan.allowAnyModel === true);
          return false;
        } catch {
          return true;
        }
      });
      if (escaped.length > 0) outcome.stopReason = `model-escape: ${escaped.join(", ")}`;
    }
  };

  for (let step = 1; ; step += 1) {
    const stop = decideStop(plan.caps, {
      startedAt: context.startedAt,
      steps: outcome.steps.length,
      calls: outcome.calls,
      tokens: outcome.tokens,
      canceled: plan.cancelFile !== "" && existsSync(plan.cancelFile),
    });
    if (stop.stop) {
      outcome.stopReason = stop.reason;
      break;
    }
    if (outcome.stopReason.startsWith("model-escape")) break;
    if (replay && replayIndex >= replay.length) {
      outcome.stopReason = "replay-complete";
      break;
    }

    const id = `x${String(step).padStart(3, "0")}`;
    const budget = {
      stepsLeft: plan.caps.maxSteps - outcome.steps.length,
      secondsLeft: secondsLeft(),
      tokensLeft: Math.max(0, plan.caps.maxTokens - outcome.tokens),
    };
    let observed: Awaited<ReturnType<typeof observe>>;
    try {
      observed = await withHangTimeout(observe(step, budget, pendingSignals), OBSERVE_TIMEOUT_MS, `observe ${id}`);
    } catch (error) {
      if (!(error instanceof DriverHang)) throw error;
      outcome.findings.push({ severity: "S2", step: id, message: `Obsidian stopped responding: ${error.message}`, source: "oracle:hang" });
      outcome.stopReason = "obsidian-unresponsive";
      break;
    }
    const { observation, errors, stats } = observed;
    pendingSignals = [];
    const elements = observation.windows.flatMap((window) => window.elements);

    // Oracles on what the previous step left behind.
    for (const error of errors) {
      const key = error.replace(/\d+/g, "#").slice(0, 200);
      const count = (seenErrors.get(key) ?? 0) + 1;
      seenErrors.set(key, count);
      if (count === 1 && /uncaught|unhandled rejection/.test(error)) {
        outcome.findings.push({ severity: "S2", step: id, message: redactSecrets(error, [apiKey]), source: "oracle:error" });
      }
    }
    if (observation.chat.running) runningSince ??= Date.now();
    else runningSince = undefined;
    if (runningSince && Date.now() - runningSince > STUCK_TURN_MS) {
      outcome.findings.push({ severity: "S2", step: id, message: `a turn ran for more than ${STUCK_TURN_MS / 1000}s`, source: "oracle:stuck" });
      runningSince = Date.now();
    }

    // Decide.
    let decision: ExplorerDecision | undefined;
    let target: ElementTarget | undefined;
    if (replay) {
      const recorded = replay[replayIndex];
      replayIndex += 1;
      decision = recorded.decision;
      const recordedRef = actionRef(decision);
      if (recordedRef && recorded.target) {
        const resolved = resolveReplayRef(recorded.target, elements);
        if (resolved) decision = { ...decision, ref: resolved } as ExplorerDecision;
        else decision = { ...decision, ref: "w99e0" } as ExplorerDecision;
      }
    } else {
      try {
        const reply = await chatComplete({
          baseUrl: plan.baseUrl,
          apiKey: plan.backend === "opencode" ? "" : (apiKey as string),
          model: plan.model,
          json: true,
          backend: plan.backend ?? "http",
          maxTokens: 2_000,
          headers: llmHeaders(plan.llm, `chaos-explore-${plan.seed}`),
          messages: [
            { role: "system", content: system },
            { role: "user", content: explorerUserPrompt({ charter, memory, history, observation, lastError: lastReplyError }) },
          ],
        });
        outcome.explorer.calls += 1;
        outcome.explorer.tokens += reply.usage.totalTokens;
        outcome.explorer.cost += reply.usage.cost;
        const parsed = parseExplorerDecision(reply.text);
        if (!parsed.ok) {
          outcome.explorer.invalidReplies += 1;
          consecutiveInvalid += 1;
          lastReplyError = parsed.error;
          await append(context.outDir, "action-log.jsonl", { t: elapsed(context), step: id, surface: "explorer", status: "invalid", detail: parsed.error, raw: redactSecrets(reply.text.slice(0, 300), [apiKey]), completionTokens: reply.usage.completionTokens });
          if (consecutiveInvalid >= MAX_INVALID_REPLIES) {
            outcome.stopReason = "explorer-invalid-replies";
            break;
          }
          await refreshUsage();
          step -= 1;
          continue;
        }
        consecutiveInvalid = 0;
        lastReplyError = undefined;
        decision = parsed.decision;
      } catch (error) {
        outcome.stopReason = `explorer-error: ${redactSecrets(message(error), [apiKey])}`;
        break;
      }
    }
    if (!decision) break;
    if (decision.memory) memory = decision.memory;
    const recordedRef = actionRef(decision);
    const element = recordedRef ? elements.find((candidate) => candidate.ref === recordedRef) : undefined;
    if (element) target = targetOf(element);
    const summary = summarizeDecision(decision, elements);

    await mark(`${id} ${decision.action}`);
    await append(context.outDir, "observations.jsonl", { step, id, stats, text: redactSecrets(formatObservation(observation), [apiKey]) });
    await append(context.outDir, "explorer-decisions.jsonl", { step, decision, target } satisfies RecordedDecision);

    let status: "passed" | "failed" = "passed";
    let outcomeText: string;
    const loop = loopVerdict(summary, allSteps);
    if (loop.action === "warn") pendingSignals.push(loop.message);
    try {
      if (loop.action === "skip") throw new Error(loop.message);
      const performMs = PERFORM_TIMEOUT_MS + (decision.action === "wait" ? decision.seconds * 1000 : 0);
      outcomeText = await withHangTimeout(perform(decision, context, secondsLeft), performMs, `${decision.action} ${id}`);
      consecutiveFailures = 0;
    } catch (error) {
      if (error instanceof DriverHang) {
        outcome.findings.push({ severity: "S2", step: id, message: `Obsidian stopped responding: ${error.message}`, source: "oracle:hang" });
        outcome.stopReason = "obsidian-unresponsive";
        await append(context.outDir, "action-log.jsonl", { t: elapsed(context), step: id, surface: decision.action, status: "failed", detail: error.message });
        break;
      }
      status = "failed";
      outcomeText = `failed: ${message(error)}`;
      consecutiveFailures += 1;
      await focusMain().catch(() => undefined);
    }

    if (decision.action === "report") {
      outcome.findings.push({
        severity: decision.severity,
        step: id,
        message: `${decision.title}: ${decision.detail}`,
        source: "explorer",
      });
    }
    const guard = await guardSettings(expected).catch(() => undefined);
    if (guard) pendingSignals.push(guard);
    if (step % 10 === 0) {
      try {
        await context.assertSessionsValid();
      } catch (error) {
        outcome.findings.push({ severity: "S1", step: id, message: message(error), source: "oracle:jsonl" });
      }
    }
    await refreshUsage();

    outcome.steps.push({ id, surface: element?.region ?? decision.action, status, detail: `${summary} -> ${outcomeText}` });
    history.push({ step, summary, outcome: outcomeText });
    allSteps.push({ step, summary, outcome: outcomeText });
    if (history.length > HISTORY_LIMIT) history.shift();
    await append(context.outDir, "action-log.jsonl", {
      t: elapsed(context),
      step: id,
      surface: element?.region ?? decision.action,
      description: summary,
      status,
      detail: redactSecrets(outcomeText, [apiKey]),
      thought: decision.thought,
      expect: decision.expect,
      previous: decision.previous,
      surprise: decision.surprise,
      errors: errors.map((error) => redactSecrets(error, [apiKey])),
      signals: observation.signals,
      tokens: outcome.tokens,
    });

    if (decision.action === "done") {
      outcome.explorer.summary = decision.summary;
      outcome.stopReason = "explorer-done";
      break;
    }
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      outcome.stopReason = "explorer-stuck";
      break;
    }
  }

  try {
    await context.assertSessionsValid();
  } catch (error) {
    outcome.findings.push({ severity: "S1", step: "end", message: message(error), source: "oracle:jsonl" });
  }
  // A hung Obsidian would hang these WebDriver calls too.
  if (outcome.stopReason !== "obsidian-unresponsive") {
    await refreshUsage().catch(() => undefined);
    await focusMain().catch(() => undefined);
  }
  return outcome;
}

function elapsed(context: ExplorerContext): number {
  return Number(((Date.now() - context.startedAt) / 1000).toFixed(3));
}
