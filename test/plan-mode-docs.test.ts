import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Doc-drift guard: `/endplan` was removed (see #60) but stayed documented,
 * so typing it leaked literal text to the model. No doc or UI comment may
 * advertise it again — exits are the inline plan card, the Plan badge, and
 * `/config`.
 */
const REPO_ROOT = join(__dirname, "..");
const GUARDED_FILES = [
  "README.md",
  "docs/guide/usage.md",
  "docs/features/context-and-control.md",
  "docs/reference/slash-commands.md",
  "docs/development/live-dogfood.md",
  "src/ui/chat-view.ts",
  "src/agent/modes.ts",
];

describe("plan mode docs", () => {
  for (const file of GUARDED_FILES) {
    it(`${file} does not advertise /endplan`, () => {
      const text = readFileSync(join(REPO_ROOT, file), "utf8");
      expect(text).not.toMatch(/\/endplan/);
    });
  }
});
