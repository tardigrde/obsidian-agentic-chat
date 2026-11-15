/**
 * Helpers shared by the trace scripts.
 *
 * Local only: no model, no socket, and no session read.
 */

import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/** Output-directory timestamp: colons and dots become dashes, and `Z` is dropped. */
export function timestampSlug(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
}

/** Show a path relative to the working directory when it is inside it. */
export function displayPath(file: string): string {
  const relative = path.relative(process.cwd(), file);
  return relative && !relative.startsWith("..") ? relative : file;
}

/**
 * Parse `--name value` options plus `--help`/`-h`. Every option is a string;
 * an unknown option or a missing value throws.
 */
export function parseStringOptions<Name extends string>(
  argv: string[],
  names: readonly Name[],
): { values: Partial<Record<Name, string>>; help: boolean } {
  const { values } = parseArgs({
    args: argv,
    options: {
      ...Object.fromEntries(names.map((name) => [name, { type: "string" as const }])),
      help: { type: "boolean", short: "h" },
    },
  });
  const { help, ...rest } = values as Record<string, string | boolean | undefined>;
  return { values: rest as Partial<Record<Name, string>>, help: help === true };
}

/** Run `main` when the module is the process entry point; print a tagged error and exit 1 on failure. */
export function runCli(metaUrl: string, tag: string, main: () => Promise<void>): void {
  if (metaUrl !== pathToFileURL(process.argv[1] ?? "").href) return;
  main().catch((error: unknown) => {
    process.stderr.write(`[${tag}] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
