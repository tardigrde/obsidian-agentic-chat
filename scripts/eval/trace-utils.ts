/**
 * Helpers shared by the trace scripts.
 *
 * Local only: no model, no socket, and no session read.
 */

import path from "node:path";
import process from "node:process";

/** Output-directory timestamp: colons and dots become dashes, and `Z` is dropped. */
export function timestampSlug(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
}

/** Show a path relative to the working directory when it is inside it. */
export function displayPath(file: string): string {
  const relative = path.relative(process.cwd(), file);
  return relative && !relative.startsWith("..") ? relative : file;
}
