import type { TurnSteeringMode } from "../agent/turn-control";

/** Strip an attachment `<context>...</context>` preamble for display/retry fallback. */
export function stripContextPreamble(text: string): string {
  return text.replace(/^<context>[\s\S]*?<\/context>\n\n/, "");
}

export function parseStreamingSteering(input: string): { mode: TurnSteeringMode; text: string } | null {
  const match = /^\/(redirect|follow-up|followup|steer)\b\s*([\s\S]*)$/i.exec(input.trim());
  if (!match) return null;
  const command = match[1].toLowerCase();
  const text = match[2].trim();
  if (!text) return null;
  if (command === "redirect") return { mode: "redirect", text };
  if (command === "follow-up" || command === "followup") return { mode: "follow-up", text };
  return { mode: "steer", text };
}

export function parseInlineInstruction(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("#")) return null;
  return trimmed.slice(1).trim() || null;
}
