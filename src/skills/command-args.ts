/**
 * Slash-command argument parsing for skill templates.
 *
 * These helpers used to live in `pi-agent-core`'s experimental harness, which
 * pi 1.0.0 removed; no other pi package ships them. The plugin owns them so
 * skill templates keep supporting the same placeholder syntax.
 */

/**
 * Split a raw argument string into arguments, honoring single and double
 * quotes so a quoted value can contain spaces. Quotes are stripped and there is
 * no escape character — this matches the behavior the plugin has always had.
 */
export function parseCommandArgs(argsString: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuote: '"' | "'" | null = null;
  for (let i = 0; i < argsString.length; i++) {
    const char = argsString[i];
    if (inQuote) {
      if (char === inQuote) inQuote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      inQuote = char;
    } else if (char === " " || char === "\t") {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (current) args.push(current);
  return args;
}

/**
 * Substitute template placeholders in `content`:
 * - `$1`..`$n` — the nth argument (1-based), empty string when out of range.
 * - `${@:N}` / `${@:N:M}` — arguments from `N`, optionally limited to `M`.
 * - `$@` / `$ARGUMENTS` — every argument joined by spaces.
 *
 * Unknown or out-of-range positions collapse to an empty string rather than
 * throwing, so a partially-filled template still renders.
 */
export function substituteArgs(content: string, args: readonly string[]): string {
  let result = content.replace(/\$(\d+)/g, (_, num: string) => args[parseInt(num, 10) - 1] ?? "");
  result = result.replace(/\$\{@:(\d+)(?::(\d+))?\}/g, (_, startStr: string, lengthStr: string | undefined) => {
    const start = Math.max(0, parseInt(startStr, 10) - 1);
    if (lengthStr) return args.slice(start, start + parseInt(lengthStr, 10)).join(" ");
    return args.slice(start).join(" ");
  });
  const allArgs = args.join(" ");
  result = result.replace(/\$ARGUMENTS/g, allArgs).replace(/\$@/g, allArgs);
  return result;
}