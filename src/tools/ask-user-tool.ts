import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

export interface AskUserRequest {
  question: string;
  choices: string[];
}

export type AskUserHandler = (request: AskUserRequest, signal?: AbortSignal) => Promise<string>;

export interface AskUserDetails {
  kind: "ask_user";
  status: "waiting" | "answered";
  question: string;
  choices: string[];
  answer?: string;
}

const AskUserParameters = Type.Object({
  question: Type.String({
    description: "clear, concise question; only when the answer changes what you do",
  }),
  choices: Type.Optional(
    Type.Array(Type.String(), {
      description: "optional answer choices; empty = free-form",
    }),
  ),
});

export function createAskUserTool(askUser: AskUserHandler): AgentTool<typeof AskUserParameters, AskUserDetails> {
  return {
    name: "ask_user",
    label: "Ask user",
    description:
      "Pause and ask the user a clarifying question, then continue with their answer. " +
      "Use instead of guessing when a missing detail affects the task; offer short choices when clear alternatives exist.",
    parameters: AskUserParameters,
    executionMode: "sequential",
    execute: async (_id, params, signal, onUpdate) => {
      const request = {
        question: params.question.trim(),
        choices: normalizeChoices(params.choices),
      };
      if (!request.question) throw new Error("ask_user requires a non-empty question.");
      onUpdate?.({
        content: [{ type: "text", text: `Waiting for the user to answer: ${request.question}` }],
        details: { kind: "ask_user", status: "waiting", ...request },
      });
      const answer = (await askUser(request, signal)).trim();
      if (!answer) throw new Error("The user did not provide an answer.");
      return {
        content: [{ type: "text", text: `User answered: ${answer}` }],
        details: { kind: "ask_user", status: "answered", ...request, answer },
      };
    },
  };
}

function normalizeChoices(value: string[] | undefined): string[] {
  const seen = new Set<string>();
  const choices: string[] = [];
  for (const raw of value ?? []) {
    const choice = raw.trim();
    if (!choice || seen.has(choice)) continue;
    seen.add(choice);
    choices.push(choice);
  }
  return choices.slice(0, 6);
}
