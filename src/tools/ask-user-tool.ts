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
    description:
      "A concise clarification question for the user. Ask only when the answer materially changes what you should do.",
  }),
  choices: Type.Optional(
    Type.Array(Type.String(), {
      description: "Optional short answer choices to render as buttons. Leave empty for a free-form answer.",
    }),
  ),
});

export function createAskUserTool(askUser: AskUserHandler): AgentTool<typeof AskUserParameters, AskUserDetails> {
  return {
    name: "ask_user",
    label: "Ask user",
    description:
      "Pause and ask the user a clarification question, then continue with their answer. " +
      "Use this instead of guessing when the missing detail materially affects the task. " +
      "Provide optional short choices when there are clear alternatives.",
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
