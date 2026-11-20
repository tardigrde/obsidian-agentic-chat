/**
 * Pure words for the activity line: one summary per turn
 * (`Searched vault, read 3 notes · 1 failed`) and the live action while a step
 * runs (`Reading Meetings/Kickoff.md`). The DOM lives in activity-line.ts.
 */

export type StepStatus = "running" | "done" | "error";

export interface SummaryStep {
  name: string;
  rawArgs: string;
  status: StepStatus;
}

interface Verb {
  /** Merge key: steps with the same key count together. */
  key: string;
  /** `read 3 notes`, `searched vault`. */
  phrase: (count: number) => string;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function parseArgs(rawArgs: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(rawArgs) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** `mcp__notion__search` → `notion`. */
export function mcpServerName(name: string): string | null {
  if (!name.startsWith("mcp__")) return null;
  return name.split("__")[1] || null;
}

/** The verb a tool call adds to the summary. */
export function stepVerb(name: string, rawArgs: string): Verb {
  const server = mcpServerName(name);
  if (server) return { key: `mcp:${server}`, phrase: (n) => (n === 1 ? `used ${server}` : `used ${server} ×${n}`) };
  switch (name) {
    case "read":
    case "get_active_note":
      return { key: "read", phrase: (n) => `read ${plural(n, "note")}` };
    case "write":
      return { key: "write", phrase: (n) => `wrote ${plural(n, "note")}` };
    case "edit":
      return { key: "edit", phrase: (n) => `edited ${n}` };
    case "rename":
      return { key: "rename", phrase: (n) => `renamed ${n}` };
    case "delete":
      return { key: "delete", phrase: (n) => `deleted ${n}` };
    case "set_properties":
      return { key: "props", phrase: (n) => `updated properties of ${plural(n, "note")}` };
    case "fetch_url":
      return { key: "fetch", phrase: (n) => `fetched ${plural(n, "page")}` };
    case "web_search":
      return { key: "web", phrase: (n) => (n === 1 ? "searched the web" : `searched the web ×${n}`) };
    case "import_document":
      return { key: "import", phrase: (n) => `imported ${plural(n, "document")}` };
    case "create_skill":
      return { key: "skill-new", phrase: (n) => (n === 1 ? "created a skill" : `created ${n} skills`) };
    case "skill":
      return { key: "skill", phrase: (n) => (n === 1 ? "loaded a skill" : `loaded ${n} skills`) };
    case "ask_user":
      return { key: "ask", phrase: () => "asked you" };
    case "subagent":
      return { key: "subagent", phrase: (n) => `ran ${plural(n, "subagent")}` };
    case "current_time":
      return { key: "time", phrase: () => "checked the time" };
    case "vault_inspect": {
      const action = text(parseArgs(rawArgs).action);
      if (action === "search") return { key: "search", phrase: (n) => (n === 1 ? "searched vault" : `searched vault ×${n}`) };
      if (action === "list") return { key: "list", phrase: (n) => (n === 1 ? "listed a folder" : `listed ${n} folders`) };
      if (action === "active_note") return { key: "read", phrase: (n) => `read ${plural(n, "note")}` };
      if (action === "local_graph") return { key: "links", phrase: (n) => (n === 1 ? "mapped links" : `mapped links ×${n}`) };
      if (action === "properties") return { key: "props-read", phrase: (n) => `read properties of ${plural(n, "note")}` };
      return { key: "inspect", phrase: (n) => (n === 1 ? "inspected the vault" : `inspected the vault ×${n}`) };
    }
    default:
      return { key: `tool:${name}`, phrase: (n) => (n === 1 ? `used ${name}` : `used ${name} ×${n}`) };
  }
}

function capitalize(value: string): string {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

/**
 * The turn's verbs, grouped in the order they first happen, counts merged per
 * verb: `Searched vault, read 4 notes, edited 1`. Failed steps are left out
 * (they show as `· N failed`). Empty when no step finished.
 */
export function summarizeSteps(steps: readonly SummaryStep[]): string {
  const order: string[] = [];
  const groups = new Map<string, { verb: Verb; count: number }>();
  for (const step of steps) {
    if (step.status !== "done") continue;
    const verb = stepVerb(step.name, step.rawArgs);
    const group = groups.get(verb.key);
    if (group) group.count += 1;
    else {
      groups.set(verb.key, { verb, count: 1 });
      order.push(verb.key);
    }
  }
  return capitalize(order.map((key) => {
    const group = groups.get(key);
    return group ? group.verb.phrase(group.count) : "";
  }).join(", "));
}

export function failedCount(steps: readonly SummaryStep[]): number {
  return steps.filter((step) => step.status === "error").length;
}

function shortTarget(value: string, max = 40): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function host(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** What a running step is doing: `Reading Meetings/Kickoff.md`. */
export function runningLabel(name: string, rawArgs: string): string {
  const args = parseArgs(rawArgs);
  const path = text(args.path) || text(args.newPath);
  const server = mcpServerName(name);
  if (server) return `Using ${server}…`;
  switch (name) {
    case "read":
      return path ? `Reading ${shortTarget(path)}` : "Reading…";
    case "get_active_note":
      return "Reading the active note…";
    case "write":
      return path ? `Writing ${shortTarget(path)}` : "Writing…";
    case "edit":
      return path ? `Editing ${shortTarget(path)}` : "Editing…";
    case "rename":
      return path ? `Renaming ${shortTarget(text(args.path) || path)}` : "Renaming…";
    case "delete":
      return path ? `Deleting ${shortTarget(path)}` : "Deleting…";
    case "set_properties":
      return path ? `Updating ${shortTarget(path)}` : "Updating properties…";
    case "fetch_url":
      return text(args.url) ? `Fetching ${host(text(args.url))}` : "Fetching…";
    case "web_search":
      return "Searching the web…";
    case "subagent":
      return "Running subagents…";
    case "ask_user":
      return "Waiting for your answer…";
    case "vault_inspect":
      return text(args.action) === "search" ? "Searching the vault…" : "Looking through the vault…";
    default:
      return `Running ${name}…`;
  }
}

/** The short verb and the argument for one compact row: `Read` + `Meetings/Kickoff.md`. */
export function stepRowParts(name: string, rawArgs: string): { verb: string; arg: string; path: string } {
  const args = parseArgs(rawArgs);
  const path = text(args.path) || text(args.newPath);
  const server = mcpServerName(name);
  if (server) return { verb: server, arg: name.split("__").slice(2).join("__"), path: "" };
  switch (name) {
    case "read":
      return { verb: "Read", arg: path, path };
    case "get_active_note":
      return { verb: "Read", arg: "active note", path: "" };
    case "write":
      return { verb: "Write", arg: path, path };
    case "edit":
      return { verb: "Edit", arg: path, path };
    case "rename":
      return { verb: "Rename", arg: [text(args.path), text(args.newPath)].filter(Boolean).join(" → "), path: text(args.newPath) };
    case "delete":
      return { verb: "Delete", arg: path, path: "" };
    case "set_properties":
      return { verb: "Properties", arg: path, path };
    case "fetch_url":
      return { verb: "Fetch", arg: text(args.url), path: "" };
    case "web_search":
      return { verb: "Search web", arg: text(args.query), path: "" };
    case "vault_inspect": {
      const action = text(args.action);
      const label = action === "search" ? "Search" : action === "list" ? "List" : action === "properties" ? "Properties" : action === "local_graph" ? "Links" : "Inspect";
      return { verb: label, arg: text(args.query) || path, path: action === "search" ? "" : path };
    }
    case "subagent":
      return { verb: "Subagents", arg: "", path: "" };
    case "ask_user":
      return { verb: "Ask", arg: text(args.question), path: "" };
    case "skill":
      return { verb: "Skill", arg: text(args.name), path: "" };
    case "create_skill":
      return { verb: "New skill", arg: text(args.name), path: "" };
    case "import_document":
      return { verb: "Import", arg: text(args.path) || text(args.url), path: "" };
    default:
      return { verb: name, arg: "", path: "" };
  }
}
