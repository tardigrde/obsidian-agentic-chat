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

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "new", description: "start a new conversation" },
  { name: "sessions", description: "browse past conversations", aliases: ["history"] },
  { name: "model", description: "switch model" },
  { name: "status", description: "show provider, model, session" },
  { name: "config", description: "switch mode & output style", aliases: ["mode", "style"] },
  { name: "usage", description: "show token & cost totals" },
  { name: "undo", description: "undo the last vault change the agent made" },
  { name: "skill", args: "[name] [args]", description: "run a vault skill; args fill $ARGUMENTS/$1", takesSkillArg: true },
  { name: "agent", args: "[name] [task]", description: "delegate a task to a subagent" },
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
