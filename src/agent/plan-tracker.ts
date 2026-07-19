export const PLAN_TRACKER_VERSION = 1;

export type PlanItemStatus = "pending" | "in_progress" | "done" | "blocked";
export type PlanTestStatus = "not_run" | "running" | "passed" | "failed" | "skipped";

export interface PlanTrackerItem {
  id: string;
  title: string;
  status: PlanItemStatus;
  testStatus: PlanTestStatus;
  checkpointCommit?: string;
  note?: string;
  updatedAt: string;
}

export interface PlanTrackerState {
  version: typeof PLAN_TRACKER_VERSION;
  title: string;
  items: PlanTrackerItem[];
  updatedAt: string;
}

export interface PlanTrackerCommandResult {
  state: PlanTrackerState | null;
  changed: boolean;
  message: string;
  error?: string;
}

export const PLAN_ITEM_STATUS_LABELS: Record<PlanItemStatus, string> = {
  pending: "pending",
  in_progress: "in progress",
  done: "done",
  blocked: "blocked",
};

export const PLAN_TEST_STATUS_LABELS: Record<PlanTestStatus, string> = {
  not_run: "not run",
  running: "running",
  passed: "passed",
  failed: "failed",
  skipped: "skipped",
};

type PlanTrackerCommand =
  | { type: "show" }
  | { type: "add"; title: string }
  | { type: "set"; id: string; status: PlanItemStatus }
  | { type: "test"; id: string; testStatus: PlanTestStatus }
  | { type: "commit"; id: string; checkpointCommit: string }
  | { type: "note"; id: string; note: string }
  | { type: "title"; title: string }
  | { type: "clear" }
  | { type: "error"; message: string };

export function runPlanTrackerCommand(
  current: PlanTrackerState | null,
  input: string,
  now = new Date().toISOString(),
): PlanTrackerCommandResult {
  const command = parsePlanTrackerCommand(input);
  if (command.type === "error") {
    return { state: current, changed: false, message: command.message, error: command.message };
  }
  if (command.type === "show") {
    return {
      state: current,
      changed: false,
      message: current?.items.length ? summarizePlanTracker(current) : "No tracked milestones yet.",
    };
  }
  if (command.type === "clear") {
    return { state: null, changed: current !== null, message: "Plan tracker cleared." };
  }

  const state = current ? clonePlanTrackerState(current) : createPlanTrackerState({ now });
  state.updatedAt = now;

  if (command.type === "title") {
    state.title = command.title;
    return { state, changed: true, message: `Plan tracker renamed to "${command.title}".` };
  }
  if (command.type === "add") {
    const item: PlanTrackerItem = {
      id: nextPlanItemId(state),
      title: command.title,
      status: "pending",
      testStatus: "not_run",
      updatedAt: now,
    };
    state.items.push(item);
    return { state, changed: true, message: `Added ${item.id}: ${item.title}.` };
  }

  const item = findPlanItem(state, command.id);
  if (!item) {
    return { state: current, changed: false, message: `No tracked milestone "${command.id}".`, error: `No tracked milestone "${command.id}".` };
  }
  item.updatedAt = now;

  if (command.type === "set") {
    item.status = command.status;
    return { state, changed: true, message: `${item.id}: status ${PLAN_ITEM_STATUS_LABELS[item.status]}.` };
  }
  if (command.type === "test") {
    item.testStatus = command.testStatus;
    return { state, changed: true, message: `${item.id}: tests ${PLAN_TEST_STATUS_LABELS[item.testStatus]}.` };
  }
  if (command.type === "commit") {
    item.checkpointCommit = command.checkpointCommit;
    return { state, changed: true, message: `${item.id}: checkpoint ${item.checkpointCommit}.` };
  }
  item.note = command.note;
  return { state, changed: true, message: `${item.id}: note updated.` };
}

export function createPlanTrackerState(options: { title?: string; now?: string } = {}): PlanTrackerState {
  const now = options.now ?? new Date().toISOString();
  return {
    version: PLAN_TRACKER_VERSION,
    title: options.title?.trim() || "Plan tracker",
    items: [],
    updatedAt: now,
  };
}

export function healPlanTrackerState(value: unknown): PlanTrackerState | null {
  if (!isRecord(value)) return null;
  const updatedAt = stringValue(value.updatedAt) || new Date(0).toISOString();
  const items = Array.isArray(value.items)
    ? value.items.map(healPlanTrackerItem).filter((item): item is PlanTrackerItem => item !== null)
    : [];
  return {
    version: PLAN_TRACKER_VERSION,
    title: stringValue(value.title) || "Plan tracker",
    items,
    updatedAt,
  };
}

export function summarizePlanTracker(state: PlanTrackerState): string {
  const total = state.items.length;
  if (total === 0) return "No tracked milestones yet.";
  const done = state.items.filter((item) => item.status === "done").length;
  const testsPassed = state.items.filter((item) => item.testStatus === "passed").length;
  const commits = state.items.filter((item) => !!item.checkpointCommit).length;
  const blocked = state.items.filter((item) => item.status === "blocked").length;
  const blockedPart = blocked > 0 ? ` · ${blocked} blocked` : "";
  return `${done}/${total} done · tests ${testsPassed}/${total} passed · ${commits} checkpoint commits${blockedPart}`;
}

export function planTrackerRows(state: PlanTrackerState | null, message: string): Array<[string, string]> {
  if (!state || state.items.length === 0) {
    return [["Status", message]];
  }
  return [
    ["Status", message],
    ["Summary", summarizePlanTracker(state)],
    ...state.items.map((item): [string, string] => [
      item.id,
      `${item.title} · ${PLAN_ITEM_STATUS_LABELS[item.status]} · tests ${PLAN_TEST_STATUS_LABELS[item.testStatus]}${
        item.checkpointCommit ? ` · commit ${item.checkpointCommit}` : ""
      }${item.note ? ` · ${item.note}` : ""}`,
    ]),
  ];
}

function parsePlanTrackerCommand(input: string): PlanTrackerCommand {
  const trimmed = input.trim();
  if (!trimmed || trimmed === "show" || trimmed === "list" || trimmed === "status") return { type: "show" };
  const [verbRaw, ...rest] = trimmed.split(/\s+/);
  const verb = verbRaw.toLowerCase();
  const restText = trimmed.slice(verbRaw.length).trim();
  return buildPlanTrackerCommand(verb, verbRaw, rest, restText);
}

function buildPlanTrackerCommand(verb: string, verbRaw: string, rest: string[], restText: string): PlanTrackerCommand {
  if (verb === "add") {
    return restText ? { type: "add", title: restText } : { type: "error", message: "Usage: /todo add <milestone>" };
  }
  if (verb === "set") {
    const [id, statusRaw] = rest;
    const status = parsePlanItemStatus(statusRaw);
    if (!id || !status) return { type: "error", message: "Usage: /todo set <id> <pending|active|done|blocked>" };
    return { type: "set", id, status };
  }
  if (verb === "test" || verb === "tests") {
    const [id, statusRaw] = rest;
    const testStatus = parsePlanTestStatus(statusRaw);
    if (!id || !testStatus) return { type: "error", message: "Usage: /todo test <id> <not-run|running|passed|failed|skipped>" };
    return { type: "test", id, testStatus };
  }
  if (verb === "commit" || verb === "checkpoint") {
    const [id, ...commitParts] = rest;
    const checkpointCommit = commitParts.join(" ").trim();
    if (!id || !checkpointCommit) return { type: "error", message: "Usage: /todo commit <id> <commit>" };
    return { type: "commit", id, checkpointCommit };
  }
  if (verb === "note") {
    const [id, ...noteParts] = rest;
    const note = noteParts.join(" ").trim();
    if (!id || !note) return { type: "error", message: "Usage: /todo note <id> <note>" };
    return { type: "note", id, note };
  }
  if (verb === "title") {
    return restText ? { type: "title", title: restText } : { type: "error", message: "Usage: /todo title <name>" };
  }
  if (verb === "clear") return { type: "clear" };
  return { type: "error", message: `Unknown /todo command "${verbRaw}".` };
}

function parsePlanItemStatus(value: string | undefined): PlanItemStatus | null {
  const normalized = normalizeToken(value);
  if (normalized === "pending" || normalized === "todo") return "pending";
  if (normalized === "active" || normalized === "progress" || normalized === "in_progress" || normalized === "doing") {
    return "in_progress";
  }
  if (normalized === "done" || normalized === "complete" || normalized === "completed" || normalized === "pass") return "done";
  if (normalized === "blocked" || normalized === "block") return "blocked";
  return null;
}

function parsePlanTestStatus(value: string | undefined): PlanTestStatus | null {
  const normalized = normalizeToken(value);
  if (normalized === "not_run" || normalized === "none" || normalized === "todo") return "not_run";
  if (normalized === "running" || normalized === "active") return "running";
  if (normalized === "passed" || normalized === "pass" || normalized === "green") return "passed";
  if (normalized === "failed" || normalized === "fail" || normalized === "red") return "failed";
  if (normalized === "skipped" || normalized === "skip") return "skipped";
  return null;
}

function normalizeToken(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/[-\s]+/g, "_");
}

function nextPlanItemId(state: PlanTrackerState): string {
  const max = state.items.reduce((highest, item) => {
    const number = Number.parseInt(item.id, 10);
    return Number.isFinite(number) ? Math.max(highest, number) : highest;
  }, 0);
  return String(max + 1);
}

function findPlanItem(state: PlanTrackerState, id: string): PlanTrackerItem | undefined {
  const lower = id.toLowerCase();
  return state.items.find((item) => item.id.toLowerCase() === lower);
}

function clonePlanTrackerState(state: PlanTrackerState): PlanTrackerState {
  return {
    ...state,
    items: state.items.map((item) => ({ ...item })),
  };
}

function healPlanTrackerItem(value: unknown): PlanTrackerItem | null {
  if (!isRecord(value)) return null;
  const id = stringValue(value.id);
  const title = stringValue(value.title);
  if (!id || !title) return null;
  return {
    id,
    title,
    status: parsePlanItemStatus(stringValue(value.status)) ?? "pending",
    testStatus: parsePlanTestStatus(stringValue(value.testStatus)) ?? "not_run",
    checkpointCommit: stringValue(value.checkpointCommit) || undefined,
    note: stringValue(value.note) || undefined,
    updatedAt: stringValue(value.updatedAt) || new Date(0).toISOString(),
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
