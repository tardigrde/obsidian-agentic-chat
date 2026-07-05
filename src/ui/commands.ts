/**
 * Single source of truth for slash commands: drives the autocomplete menu, the
 * `/help` listing, and command routing in `ChatView`. Keep this list and the
 * `handleSlashCommand` switch in sync — the switch resolves names via `resolveCommand`.
 */
export interface SlashCommand {
  /** Canonical command word (no leading slash). */
  name: string;
  /** Argument hint shown after the name in menus, e.g. "[name] [args]". */
  args?: string;
  description: string;
  /** Hidden from the autocomplete menu and `/help`, but still routable. */
  hidden?: boolean;
  /** Takes a skill name as its first argument; drives `/skill`-style autocomplete. */
  takesSkillArg?: boolean;
  /** Alternate words that route to this command. */
  aliases?: string[];
}

export interface ParsedSlashInput {
  raw: string;
  word: string;
  argString: string;
  args: readonly string[];
  command?: SlashCommand;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "new", description: "start a new conversation" },
  { name: "sessions", args: "[clear --confirm]", description: "browse or clear past conversations", aliases: ["history"] },
  { name: "model", description: "switch model" },
  { name: "status", description: "show provider, model, session, MCP" },
  { name: "project", args: "[name|clear]", description: "switch project workspace", aliases: ["projects"] },
  { name: "memory", args: "[add|review|manage|export|clear]", description: "add, review, export, or clear stored memories" },
  { name: "semantic-index", args: "[status|estimate|start|cancel]", description: "manage scoped semantic indexing", aliases: ["semindex"] },
  { name: "diagnostics", description: "show dev runtime diagnostics", aliases: ["diag"] },
  { name: "config", description: "switch permission mode (Safe / YOLO)", aliases: ["mode"] },
  { name: "add-dir", args: "[folder]", description: "grant a working directory (auto-run inside, ask outside)", aliases: ["adddir"] },
  { name: "dirs", description: "list/revoke granted working directories", aliases: ["working-dirs"] },
  { name: "plan", description: "enter read-only plan mode (sticky)" },
  { name: "endplan", description: "leave plan mode, restoring Safe/YOLO" },
  { name: "todo", args: "[add|set|test|commit]", description: "track milestones, tests, and checkpoint commits", aliases: ["todos"] },
  { name: "steer", args: "[text]", description: "steer the active turn while the agent is responding" },
  { name: "follow-up", args: "[text]", description: "queue a follow-up behind the active turn", aliases: ["followup"] },
  { name: "redirect", args: "[text]", description: "stop the active turn and answer this instead" },
  { name: "style", args: "[name]", description: "switch output style" },
  { name: "effort", args: "[level]", description: "set reasoning effort for the next message", aliases: ["thinking"] },
  { name: "usage", description: "show token & cost totals" },
  { name: "compact", args: "[instructions]", description: "summarize older turns now; optional instructions guide the summary" },
  { name: "export", description: "save this conversation as a Markdown note" },
  { name: "undo", description: "undo the last vault change the agent made" },
  { name: "skill", args: "[name] [args]", description: "run a vault skill; args fill $ARGUMENTS/$1", takesSkillArg: true },
  { name: "agent", args: "[name] [task]", description: "delegate a task to a subagent" },
  { name: "init", args: "[instructions]", description: "curate the vault's AGENTS.md standing-instructions file" },
  { name: "help", description: "show this list" },
  {
    name: "template",
    args: "[name] [args]",
    description: "deprecated alias for /skill",
    takesSkillArg: true,
    hidden: true,
  },
];

/** Commands shown in menus and `/help` (deprecated/internal ones excluded). */
export function visibleCommands(): SlashCommand[] {
  return SLASH_COMMANDS.filter((command) => !command.hidden);
}

/** Resolve a typed word (canonical name or alias) to its command, case-insensitively. */
export function resolveCommand(word: string): SlashCommand | undefined {
  const lower = word.toLowerCase();
  return SLASH_COMMANDS.find(
    (command) => command.name === lower || command.aliases?.includes(lower),
  );
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
