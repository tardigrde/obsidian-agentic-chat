/**
 * *How* the assistant talks — tone and structure — as a system-prompt overlay.
 * Distinct from modes (what it may do) and skills (reusable capabilities).
 * Built-in set only for now; custom user styles are deferred.
 */
export type OutputStyle = "default" | "brainstorm" | "learning";

export const DEFAULT_OUTPUT_STYLE: OutputStyle = "default";

/** Display order for menus and the composer dropdown (default first). */
export const OUTPUT_STYLE_ORDER: OutputStyle[] = ["default", "brainstorm", "learning"];

export interface OutputStyleDefinition {
  id: OutputStyle;
  label: string;
  /** Lucide icon name for pickers. */
  icon: string;
  description: string;
  /** Appended to the system prompt. Empty for the default (no overlay). */
  promptOverlay: string;
}

export const OUTPUT_STYLES: Record<OutputStyle, OutputStyleDefinition> = {
  default: {
    id: "default",
    label: "Default",
    icon: "message-square",
    description: "Concise, direct answers.",
    promptOverlay: "",
  },
  brainstorm: {
    id: "brainstorm",
    label: "Brainstorm",
    icon: "lightbulb",
    description: "Explore options and provoke ideas before converging.",
    promptOverlay:
      "Adopt a **brainstorming** style: favour breadth before depth. Offer several distinct " +
      "options or angles, ask clarifying questions when the goal is ambiguous, and surface " +
      "non-obvious connections between notes. Hold off on a single recommendation until the " +
      "user has reacted to the possibilities.",
  },
  learning: {
    id: "learning",
    label: "Learning",
    icon: "graduation-cap",
    description: "Explain reasoning and teach as you go.",
    promptOverlay:
      "Adopt a **learning** style: explain your reasoning as you work, define unfamiliar terms, " +
      "and call out why a step matters, not just what it does. Prefer small, well-explained " +
      "steps over a single dense answer, and end with a brief recap the user can learn from.",
  },
};
