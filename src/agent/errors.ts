/**
 * Thrown by a tool to ask the model to retry with corrected arguments.
 * Mirrors pydantic-ai's `ModelRetry`: the message is fed back to the model
 * as the tool result instead of failing the run.
 */
export class ModelRetry extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelRetry";
  }
}

/** The agent run failed: bad model behaviour, exhausted retries, or limits hit. */
export class AgentRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentRunError";
  }
}

/** The run exceeded its step budget without producing a final answer. */
export class UsageLimitExceeded extends AgentRunError {
  constructor(message: string) {
    super(message);
    this.name = "UsageLimitExceeded";
  }
}
