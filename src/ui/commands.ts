/**
 * Single source of truth for slash commands: drives the autocomplete menu, the
 * `/help` listing, and command routing in `ChatView`. Routing is a
 * `Record<SlashCommandName, handler>`, so a command added here without a
 * handler fails the typecheck.
 */
export interface SlashCommand {
  /** Canonical command word (no leading slash). */
  name: string;
  /** Argument hint shown after the name in menus, e.g. "[name] [args]". */
  args?: string;
  description: string;
  /** Takes a skill name as its first argument; drives `/skill`-style autocomplete. */
  takesSkillArg?: boolean;
}

export interface ParsedSlashInput {
  raw: string;
  word: string;
  argString: string;
  args: readonly string[];
  command?: SlashCommandEntry;
}

export const SLASH_COMMANDS = [
  { name: "new", description: "start a new conversation" },
  { name: "sessions", args: "[clear --confirm]", description: "browse or clear past conversations" },
  { name: "model", description: "switch model" },
  { name: "status", description: "show provider, model, session, MCP" },
  { name: "memory", args: "[add|review|manage|export|clear]", description: "add, review, export, or clear stored memories" },
  { name: "semantic-index", args: "[status|estimate|start|cancel]", description: "manage scoped semantic indexing" },
  { name: "doctor", description: "audit runtime health, agent plugins, and MCP configs" },
  { name: "style", args: "[name]", description: "switch output style" },
  { name: "effort", args: "[level]", description: "set reasoning effort for your messages (persisted)" },
  { name: "usage", description: "show token & cost totals" },
  { name: "compact", args: "[instructions]", description: "summarize older turns now; optional instructions guide the summary" },
  { name: "export", description: "save this conversation as a Markdown note" },
  { name: "undo", description: "undo the last vault change the agent made" },
  { name: "skill", args: "[name] [args]", description: "run a vault skill; args fill $ARGUMENTS/$1", takesSkillArg: true },
  { name: "agent", args: "[name] [task]", description: "delegate a task to a subagent" },
  { name: "init", args: "[instructions]", description: "curate the vault's AGENTS.md standing-instructions file" },
  { name: "help", description: "show this list" },
] as const satisfies readonly SlashCommand[];

/** One entry of `SLASH_COMMANDS`, with its literal name. */
export type SlashCommandEntry = (typeof SLASH_COMMANDS)[number];
/** Canonical name of a built-in slash command. */
export type SlashCommandName = SlashCommandEntry["name"];

/** Commands shown in menus and `/help`. */
export function visibleCommands(): SlashCommand[] {
  return [...SLASH_COMMANDS];
}

/** Resolve a typed canonical name, case-insensitively. */
export function resolveCommand(word: string): SlashCommandEntry | undefined {
  const lower = word.toLowerCase();
  return SLASH_COMMANDS.find((command) => command.name === lower);
}

/** Parse a slash command while preserving the full trimmed argument tail. */
export function parseSlashInput(raw: string): ParsedSlashInput {
  const body = raw.startsWith("/") ? raw.slice(1) : raw;
  const match = /^(\S*)([\s\S]*)$/.exec(body);
  const word = match?.[1] ?? "";
  const argString = (match?.[2] ?? "").trim();
  return {
    raw,
    word,
    argString,
    args: argString ? argString.split(/\s+/) : [],
    command: resolveCommand(word),
  };
}

/** Return the command argument tail after the first positional argument. */
export function slashInputTailAfterFirst(input: ParsedSlashInput): string {
  const first = input.args[0];
  return first ? input.argString.slice(first.length).trim() : "";
}

const IGNORED_FILES_HINT =
  "the agent can read the whole vault. To keep it out of a folder, add it to Settings → Advanced → Ignored files.";
const MODE_HINT = "use the Safe/YOLO toggle in the composer or Settings → Permission mode.";

/**
 * Commands and aliases removed by the product cuts, mapped to what replaces them.
 * Typing one shows its hint instead of sending the literal text to the model.
 */
const RETIRED_COMMAND_HINTS: Readonly<Record<string, string>> = {
  steer: "press Enter while the agent responds to steer.",
  "follow-up": "while the agent responds, type your message and press Queue to send it after the current turn.",
  followup: "while the agent responds, type your message and press Queue to send it after the current turn.",
  redirect: "press Stop, then send your new message.",
  config: MODE_HINT,
  mode: MODE_HINT,
  history: "use /sessions.",
  semindex: "use /semantic-index.",
  thinking: "use /effort.",
  todo: "the todo tracker is gone. Ask the agent to keep a checklist in a note instead.",
  todos: "the todo tracker is gone. Ask the agent to keep a checklist in a note instead.",
  "add-dir": IGNORED_FILES_HINT,
  dirs: IGNORED_FILES_HINT,
  "working-dirs": IGNORED_FILES_HINT,
};

/** Hint for a retired command word (case-insensitive), or undefined when it was never retired. */
export function retiredCommandHint(word: string): string | undefined {
  const lower = word.toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(RETIRED_COMMAND_HINTS, lower)) return undefined;
  return `/${lower} was removed: ${RETIRED_COMMAND_HINTS[lower]}`;
}
