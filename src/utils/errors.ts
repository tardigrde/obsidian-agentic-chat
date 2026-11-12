/** Message of a thrown value: `Error.message`, or `String(value)` for anything else. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
