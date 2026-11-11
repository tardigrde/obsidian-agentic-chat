/**
 * Pure policy for the open-ended chaos explorer.
 *
 * The explorer is a model that reads a compact text view of every Obsidian
 * window and returns one UI action per step. This module owns every decision a
 * unit test can pin down: the action schema, response parsing, the prompt, the
 * replay match, and real-usage accounting. The in-app driver
 * (`test/e2e/chaos/explorer-driver.ts`) only collects the view and performs the
 * action.
 */

export type UiRegion =
  | "modal"
  | "menu"
  | "suggest"
  | "settings"
  | "settings-nav"
  | "chat"
  | "editor"
  | "tabs"
  | "files"
  | "ribbon"
  | "other";

export type UiElement = {
  /** Stable for one observation only, for example `w0e12`. */
  ref: string;
  window: number;
  region: UiRegion;
  role: string;
  label: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
};

export type WindowObservation = {
  index: number;
  title: string;
  modalTitles: string[];
  notices: string[];
  elements: UiElement[];
  /** Elements that matched but did not fit the per-window limit. */
  hidden: number;
};

export type ChatState = {
  open: boolean;
  running: boolean;
  composer: string;
  errorPanels: number;
  approvalOpen: boolean;
  overflowX: boolean;
  lastMessages: Array<{ role: "user" | "assistant" | "info"; text: string }>;
};

export type Observation = {
  step: number;
  windows: WindowObservation[];
  chat: ChatState;
  activeFile?: string;
  vaultFiles: string[];
  /** New console errors, uncaught errors, and unhandled rejections since the last step. */
  errors: string[];
  /** Oracle signals from the driver, for example a restored protected setting. */
  signals: string[];
  budget: { stepsLeft: number; secondsLeft: number; tokensLeft: number };
};

export const EXPLORER_ACTIONS = [
  "click",
  "type",
  "key",
  "scroll",
  "command",
  "send",
  "wait",
  "resize",
  "open_settings",
  "close_window",
  "reload_plugin",
  "scenario",
  "report",
  "done",
] as const;
export type ExplorerActionName = (typeof EXPLORER_ACTIONS)[number];

export type ExplorerAction =
  | { action: "click"; ref: string }
  | { action: "type"; ref: string; text: string; submit?: boolean }
  | { action: "key"; keys: string; window?: number }
  | { action: "scroll"; ref: string; dy: number }
  | { action: "command"; id: string }
  | { action: "send"; text: string; wait?: boolean }
  | { action: "wait"; seconds: number }
  | { action: "resize"; width: number; height: number }
  | { action: "open_settings" }
  | { action: "close_window"; window: number }
  | { action: "reload_plugin" }
  | { action: "scenario"; name: string }
  | { action: "report"; severity: "S1" | "S2" | "S3" | "S4"; title: string; detail: string }
  | { action: "done"; summary: string };

export type ExplorerDecision = ExplorerAction & {
  /** Why the explorer picks this action. Short. */
  thought: string;
  /** What the explorer expects to see after the action. The miner compares it. */
  expect: string;
  /** The explorer's verdict on the previous step's outcome. */
  previous: "as-expected" | "surprising" | "n/a";
  /** Why the previous outcome was surprising, when it was. */
  surprise?: string;
  /** Running notes that replace the previous memory. */
  memory?: string;
};

export type ParseResult = { ok: true; decision: ExplorerDecision } | { ok: false; error: string };

const MAX_TEXT = 4_000;
const MAX_WAIT_SECONDS = 30;
const SEVERITIES = new Set(["S1", "S2", "S3", "S4"]);

function str(value: unknown, field: string, max = MAX_TEXT): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be a non-empty string`);
  return value.length > max ? value.slice(0, max) : value;
}

function optStr(value: unknown, max = 1_500): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return value.length > max ? value.slice(0, max) : value;
}

function num(value: unknown, field: string): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) throw new Error(`${field} must be a number`);
  return parsed;
}

function ref(value: unknown): string {
  const text = str(value, "ref", 32).trim();
  if (!/^w\d+e\d+$/.test(text)) throw new Error(`ref must look like w0e12, got ${text}`);
  return text;
}

/** Take the first balanced JSON object out of a model reply. */
export function extractJsonObject(text: string): string | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const source = fenced ? fenced[1] : text;
  const start = source.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return undefined;
}

function parseAction(raw: Record<string, unknown>): ExplorerAction {
  const name = raw.action;
  switch (name) {
    case "click":
      return { action: "click", ref: ref(raw.ref) };
    case "type":
      return {
        action: "type",
        ref: ref(raw.ref),
        text: typeof raw.text === "string" ? raw.text.slice(0, MAX_TEXT) : "",
        submit: raw.submit === true,
      };
    case "key":
      return {
        action: "key",
        keys: str(raw.keys, "keys", 60),
        window: raw.window === undefined ? undefined : Math.max(0, Math.trunc(num(raw.window, "window"))),
      };
    case "scroll":
      return { action: "scroll", ref: ref(raw.ref), dy: Math.trunc(num(raw.dy, "dy")) };
    case "command":
      return { action: "command", id: str(raw.id, "id", 120).trim() };
    case "send":
      return { action: "send", text: str(raw.text, "text", 40_000), wait: raw.wait !== false };
    case "wait":
      return { action: "wait", seconds: Math.min(MAX_WAIT_SECONDS, Math.max(0, num(raw.seconds, "seconds"))) };
    case "resize":
      return {
        action: "resize",
        width: Math.trunc(num(raw.width, "width")),
        height: Math.trunc(num(raw.height, "height")),
      };
    case "open_settings":
      return { action: "open_settings" };
    case "close_window":
      return { action: "close_window", window: Math.trunc(num(raw.window, "window")) };
    case "reload_plugin":
      return { action: "reload_plugin" };
    case "scenario":
      return { action: "scenario", name: str(raw.name, "name", 60).trim() };
    case "report": {
      const severity = typeof raw.severity === "string" ? raw.severity.toUpperCase() : "S3";
      return {
        action: "report",
        severity: (SEVERITIES.has(severity) ? severity : "S3") as "S1" | "S2" | "S3" | "S4",
        title: str(raw.title, "title", 200),
        detail: str(raw.detail, "detail"),
      };
    }
    case "done":
      return { action: "done", summary: str(raw.summary, "summary") };
    default:
      throw new Error(`unknown action ${JSON.stringify(name)}; use one of ${EXPLORER_ACTIONS.join(", ")}`);
  }
}

/** Parse one explorer reply. Never throws; a bad reply is fed back to the explorer. */
export function parseExplorerDecision(text: string): ParseResult {
  const json = extractJsonObject(text);
  if (!json) return { ok: false, error: "reply had no JSON object" };
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    return { ok: false, error: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "reply was not an object" };
  const record = raw as Record<string, unknown>;
  try {
    const action = parseAction(record);
    const previous =
      record.previous === "as-expected" || record.previous === "surprising" ? record.previous : "n/a";
    return {
      ok: true,
      decision: {
        ...action,
        thought: optStr(record.thought, 600) ?? "",
        expect: optStr(record.expect, 600) ?? "",
        previous,
        surprise: optStr(record.surprise, 1_000),
        memory: optStr(record.memory, 2_000),
      },
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** The ref an action targets, when it targets one element. */
export function actionRef(action: ExplorerAction): string | undefined {
  return action.action === "click" || action.action === "type" || action.action === "scroll" ? action.ref : undefined;
}

export function refWindow(value: string): number {
  const match = /^w(\d+)e\d+$/.exec(value);
  return match ? Number(match[1]) : 0;
}

/** A stable description of an element, so a replay can find it again. */
export type ElementTarget = Pick<UiElement, "window" | "region" | "role" | "label">;

export function targetOf(element: UiElement): ElementTarget {
  return { window: element.window, region: element.region, role: element.role, label: element.label };
}

/**
 * Find the element a recorded decision targeted in a fresh observation. Refs
 * change between runs; window, role, and label usually do not. Prefer an exact
 * match, then the same label in the same window.
 */
export function resolveReplayRef(target: ElementTarget, elements: UiElement[]): string | undefined {
  const exact = elements.find(
    (element) =>
      element.window === target.window &&
      element.region === target.region &&
      element.role === target.role &&
      element.label === target.label,
  );
  if (exact) return exact.ref;
  const sameLabel = elements.find((element) => element.window === target.window && element.label === target.label);
  return sameLabel?.ref;
}

/** Map an explorer key chord such as `Mod+Shift+P` to WebDriver key names. */
export function parseKeyChord(chord: string, platform: string = process.platform): string[] {
  const names: Record<string, string> = {
    mod: platform === "darwin" ? "Meta" : "Control",
    ctrl: "Control",
    control: "Control",
    cmd: "Meta",
    meta: "Meta",
    shift: "Shift",
    alt: "Alt",
    option: "Alt",
    esc: "Escape",
    escape: "Escape",
    enter: "Enter",
    return: "Enter",
    tab: "Tab",
    space: " ",
    backspace: "Backspace",
    delete: "Delete",
    up: "ArrowUp",
    down: "ArrowDown",
    left: "ArrowLeft",
    right: "ArrowRight",
    arrowup: "ArrowUp",
    arrowdown: "ArrowDown",
    arrowleft: "ArrowLeft",
    arrowright: "ArrowRight",
    home: "Home",
    end: "End",
    pageup: "PageUp",
    pagedown: "PageDown",
  };
  const parts = chord
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) throw new Error("keys must name at least one key");
  return parts.map((part) => {
    const mapped = names[part.toLowerCase()];
    if (mapped) return mapped;
    if (/^f\d{1,2}$/i.test(part)) return part.toUpperCase();
    if (part.length === 1) return part.toLowerCase();
    throw new Error(`unknown key ${part}`);
  });
}

/** Render one observation as compact text for the explorer. */
export function formatObservation(observation: Observation): string {
  const lines: string[] = [];
  lines.push(
    `STEP ${observation.step} | steps left ${observation.budget.stepsLeft} | seconds left ${observation.budget.secondsLeft} | tokens left ${observation.budget.tokensLeft}`,
  );
  const chat = observation.chat;
  lines.push(
    `CHAT open=${chat.open} running=${chat.running} approvalOpen=${chat.approvalOpen} errorPanels=${chat.errorPanels} overflowX=${chat.overflowX}`,
  );
  if (chat.composer) lines.push(`COMPOSER "${clip(chat.composer, 200)}"`);
  for (const message of chat.lastMessages) lines.push(`  ${message.role}: ${clip(message.text, 500)}`);
  if (observation.activeFile) lines.push(`ACTIVE FILE ${observation.activeFile}`);
  if (observation.vaultFiles.length > 0) lines.push(`VAULT ${clip(observation.vaultFiles.join(", "), 600)}`);
  if (observation.errors.length > 0) {
    lines.push("NEW ERRORS");
    for (const error of observation.errors.slice(0, 8)) lines.push(`  ! ${clip(error, 300)}`);
  }
  if (observation.signals.length > 0) {
    lines.push("SIGNALS");
    for (const signal of observation.signals) lines.push(`  * ${clip(signal, 300)}`);
  }
  for (const window of observation.windows) {
    lines.push(`WINDOW ${window.index} "${clip(window.title, 80)}"${window.index === 0 ? " (main)" : ""}`);
    if (window.modalTitles.length > 0) lines.push(`  modals: ${window.modalTitles.map((t) => `"${clip(t, 80)}"`).join(", ")}`);
    if (window.notices.length > 0) lines.push(`  notices: ${window.notices.map((t) => `"${clip(t, 120)}"`).join(", ")}`);
    let region = "";
    for (const element of window.elements) {
      if (element.region !== region) {
        region = element.region;
        lines.push(`  [${region}]`);
      }
      const flags = [
        element.disabled ? "disabled" : "",
        element.checked === undefined ? "" : element.checked ? "on" : "off",
        element.value ? `value="${clip(element.value, 80)}"` : "",
      ]
        .filter(Boolean)
        .join(" ");
      lines.push(`  ${element.ref} ${element.role} "${clip(element.label, 90)}"${flags ? ` ${flags}` : ""}`);
    }
    if (window.hidden > 0) lines.push(`  (+${window.hidden} more elements not shown; scroll or close overlays)`);
  }
  return lines.join("\n");
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export type StepRecord = {
  step: number;
  summary: string;
  outcome: string;
};

export function explorerSystemPrompt(scenarios: string[], commands: string[]): string {
  return `You are an exploratory QA tester for "Agentic Chat", an Obsidian plugin that adds an AI chat pane with vault tools, slash commands, approvals, sessions, settings, and MCP.

You drive the real Obsidian app in a disposable test vault. Each turn you get a text view of every open window and you reply with exactly ONE JSON object: the next action. Your job is to find bugs a human tester would find: broken flows, wrong or missing feedback, errors, stuck states, lost data, confusing UI, layout breaks, and crashes. Be curious and adversarial, but act like a real user: open menus, try odd inputs, change settings, interrupt turns, switch sessions, reload the plugin, resize the window, use keyboard shortcuts, and combine features.

Reply format (JSON only, no prose):
{"thought": "<why, one or two sentences>", "previous": "as-expected" | "surprising" | "n/a", "surprise": "<only if surprising: what you saw versus what you expected>", "expect": "<what you expect after this action>", "memory": "<optional: notes to keep; replaces earlier memory; keep under 1500 chars>", "action": "<name>", ...action fields}

Actions:
- {"action":"click","ref":"w0e12"}                      click an element from the view
- {"action":"type","ref":"w0e3","text":"...","submit":false}  replace the text of an input, textarea, or editor; submit=true presses Enter after
- {"action":"key","keys":"Mod+P","window":0}           key chord in a window (Mod = Ctrl). Examples: Escape, Enter, Mod+Shift+P, ArrowDown
- {"action":"scroll","ref":"w0e5","dy":600}            scroll the element's scroll container
- {"action":"command","id":"agentic-chat:open-chat"}    run an Obsidian command by id
- {"action":"send","text":"...","wait":true}           type in the chat composer and send; wait=false returns at once so you can steer, queue, or stop the turn
- {"action":"wait","seconds":5}                        wait up to 30 s, for example for a running turn
- {"action":"resize","width":900,"height":700}         resize the main window (narrow widths test the mobile-like layout)
- {"action":"open_settings"}                           open the Agentic Chat settings (opens its own window)
- {"action":"close_window","window":1}                 close a non-main window, for example settings
- {"action":"reload_plugin"}                           disable and enable the plugin, like an update or restart
- {"action":"scenario","name":"queue"}                 run a scripted multi-step scenario with built-in checks. Names: ${scenarios.join(", ")}
- {"action":"report","severity":"S2","title":"...","detail":"..."}  record a bug you are confident about, with what you did, saw, and expected. S1 data loss or crash, S2 broken feature, S3 wrong or confusing behavior, S4 cosmetic
- {"action":"done","summary":"..."}                    stop when you covered the charter or the budget is almost gone

Plugin commands you can run: ${commands.length > 0 ? commands.join(", ") : "(read them from the command palette)"}

Rules:
- Use only refs from the CURRENT view. Refs change every step.
- Do not change the provider, model, base URL, or API key settings. The driver restores them and the run uses one fixed model.
- Do not quit Obsidian, open the developer tools, or leave the test vault.
- Chat prompts cost tokens. Prefer short prompts; use a long prompt only when you test large input on purpose.
- Approval modals appear for note writes. Decide like a user: sometimes allow, sometimes deny, sometimes ignore.
- When a step is surprising, say so in "previous" and "surprise". When you are confident it is a bug, use "report" on the next step.
- Do not repeat the same action more than three times in a row. Cover many different surfaces.
- When an action fails, read the error in HISTORY and try another way.`;
}

export type ExplorerPromptInput = {
  charter: string;
  memory: string;
  history: StepRecord[];
  observation: Observation;
  lastError?: string;
};

export function explorerUserPrompt(input: ExplorerPromptInput): string {
  const history =
    input.history.length > 0
      ? input.history.map((record) => `#${record.step} ${record.summary} -> ${record.outcome}`).join("\n")
      : "(none yet)";
  return [
    `CHARTER\n${input.charter.trim()}`,
    `MEMORY\n${input.memory.trim() || "(empty)"}`,
    `HISTORY (latest last)\n${history}`,
    input.lastError ? `YOUR LAST REPLY WAS REJECTED: ${input.lastError}. Reply with one valid JSON object.` : "",
    `CURRENT VIEW\n${formatObservation(input.observation)}`,
    "Reply with the next action as one JSON object.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** One-line summary of a decision for the explorer history and the action log. */
export function summarizeDecision(decision: ExplorerAction, elements: UiElement[] = []): string {
  const label = (target: string): string => {
    const element = elements.find((candidate) => candidate.ref === target);
    return element ? `${element.role} "${clip(element.label, 50)}" (${element.region}, w${element.window})` : target;
  };
  switch (decision.action) {
    case "click":
      return `click ${label(decision.ref)}`;
    case "type":
      return `type "${clip(decision.text, 80)}" into ${label(decision.ref)}${decision.submit ? " + Enter" : ""}`;
    case "key":
      return `key ${decision.keys}${decision.window ? ` in w${decision.window}` : ""}`;
    case "scroll":
      return `scroll ${label(decision.ref)} by ${decision.dy}`;
    case "command":
      return `command ${decision.id}`;
    case "send":
      return `send "${clip(decision.text, 120)}"${decision.wait === false ? " (no wait)" : ""}`;
    case "wait":
      return `wait ${decision.seconds}s`;
    case "resize":
      return `resize ${decision.width}x${decision.height}`;
    case "open_settings":
      return "open settings";
    case "close_window":
      return `close window ${decision.window}`;
    case "reload_plugin":
      return "reload plugin";
    case "scenario":
      return `scenario ${decision.name}`;
    case "report":
      return `report ${decision.severity} "${clip(decision.title, 100)}"`;
    case "done":
      return `done: ${clip(decision.summary, 200)}`;
  }
}

export type SessionUsage = {
  tokens: number;
  cost: number;
  assistantMessages: number;
  models: string[];
};

/** Sum real usage from session JSONL text. Lines that do not parse are skipped. */
export function sumSessionUsage(jsonlTexts: string[]): SessionUsage {
  const usage: SessionUsage = { tokens: 0, cost: 0, assistantMessages: 0, models: [] };
  const models = new Set<string>();
  for (const text of jsonlTexts) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.includes('"assistant"')) continue;
      let entry: { type?: string; message?: { role?: string; model?: string; usage?: { totalTokens?: number; cost?: { total?: number } } } };
      try {
        entry = JSON.parse(line) as typeof entry;
      } catch {
        continue;
      }
      const message = entry.message;
      if (entry.type !== "message" || message?.role !== "assistant") continue;
      usage.assistantMessages += 1;
      if (message.model) models.add(message.model);
      const tokens = message.usage?.totalTokens;
      if (typeof tokens === "number" && Number.isFinite(tokens)) usage.tokens += tokens;
      const cost = message.usage?.cost?.total;
      if (typeof cost === "number" && Number.isFinite(cost)) usage.cost += cost;
    }
  }
  usage.models = [...models].sort();
  return usage;
}

/** Built-in charters. A charter file in the skill folder can replace or add to them. */
export const BUILTIN_CHARTERS: Record<string, string> = {
  broad:
    "Explore the whole plugin like a curious new user on day one. Cover the chat composer, slash commands, @-mentions, note reads and writes with approvals, session tabs and history, settings tabs, the Quick Ask command on selected editor text, the command palette, and narrow window widths. Spend at most a third of the steps on any one surface. Report every bug you are confident about.",
};
