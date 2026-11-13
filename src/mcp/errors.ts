/** Diagnostic category for an MCP failure, carried by the error itself. */
export type McpErrorCategory = "auth" | "http" | "network" | "protocol" | "timeout" | "unknown";

/**
 * Typed MCP failure. Callers read `category` instead of matching user-facing
 * message text; `message` stays the exact text a user or log already sees.
 */
export class McpError extends Error {
  constructor(
    readonly category: McpErrorCategory,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "McpError";
  }
}
