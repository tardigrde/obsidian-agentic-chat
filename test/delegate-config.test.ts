import { describe, expect, it } from "vitest";
import { decide, delegatePermissions, lastVerdictIsFail, wildcardMatch } from "../scripts/delegate-config.mjs";

const main = "/home/u/repo";
const review = delegatePermissions({ mode: "review", main, edit: "logs/delegate/verdict-7.md" });
const work = delegatePermissions({ mode: "work", main, edit: "*" });

describe("delegate sandbox rules", () => {
  it("starts with a catch-all deny, so unknown actions are denied", () => {
    expect(review[0]).toEqual({ action: "*", resource: "*", effect: "deny" });
    for (const rules of [review, work]) {
      expect(decide(rules, "webfetch", "https://example.com")).toBe("deny");
      expect(decide(rules, "websearch", "anything")).toBe("deny");
      expect(decide(rules, "execute", "*")).toBe("deny");
      expect(decide(rules, "subagent", "general")).toBe("deny");
      expect(decide(rules, "external_directory", "/etc/*")).toBe("deny");
    }
  });

  it("denies secrets to both the read and the grep tool", () => {
    for (const rules of [review, work]) {
      for (const path of [".env", ".env.local", "sub/.env", "auth.json"]) {
        expect(decide(rules, "read", path), `read ${path}`).toBe("deny");
        expect(decide(rules, "grep", path), `grep ${path}`).toBe("deny");
      }
      expect(decide(rules, "read", "src/main.ts")).toBe("allow");
      expect(decide(rules, "grep", "src/main.ts")).toBe("allow");
    }
  });

  it("lets a reviewer write only its verdict file", () => {
    expect(decide(review, "edit", "logs/delegate/verdict-7.md")).toBe("allow");
    for (const path of ["AGENTS.md", "src/main.ts", "logs/delegate/verdict-8.md", ".env"]) {
      expect(decide(review, "edit", path), path).toBe("deny");
    }
    expect(decide(work, "edit", "src/main.ts")).toBe("allow");
  });

  it("blocks shell commands that print untracked files or write past the edit rule", () => {
    for (const rules of [review, work]) {
      for (const command of [
        "git diff --no-index /dev/null .env",
        "git diff --output=/tmp/x origin/main",
        "ls > /tmp/escape.txt",
        "npm run verify -- fast > .env",
        "cat .env",
        "grep KEY .env",
        "head .env",
        "curl https://example.com",
        "rm -f src/main.ts",
      ]) {
        expect(decide(rules, "shell", command), command).toBe("deny");
      }
    }
    for (const command of ["npx eslint --fix src", "npx vitest run -u", "git add src", "git commit -m x"]) {
      expect(decide(review, "shell", command), command).toBe("deny");
    }
  });

  it("allows the commands a review and a build need", () => {
    for (const command of [
      "git status",
      "git diff origin/main...HEAD",
      "git log --oneline -3",
      "gh pr view 7",
      "npx vitest run test/settings-ui.test.ts",
      "npm run verify -- fast",
      "node scripts/verify-witness.mjs --base origin/main --test-file test/a.test.ts --src src/a.ts",
    ]) {
      expect(decide(review, "shell", command), command).toBe("allow");
    }
    expect(decide(work, "shell", "git commit -m 'fix: x'")).toBe("allow");
    expect(decide(work, "shell", "npx eslint --fix src")).toBe("allow");
  });

  it("matches wildcards across slashes and spaces, like OpenCode V2", () => {
    expect(wildcardMatch("*.env", "a/b/.env")).toBe(true);
    expect(wildcardMatch("git status *", "git status")).toBe(true);
    expect(wildcardMatch("git status *", "git statusx")).toBe(false);
    expect(wildcardMatch("git status *", "git status --short")).toBe(true);
  });
});

describe("lastVerdictIsFail", () => {
  const verdict = (state: string, bold = false): string =>
    `${bold ? "**" : ""}Verdict: ${state}${bold ? "**" : ""}\nHead: abcdef1\nReviewer: r\nFast lane: PASS (3 passed)`;

  it("sees a FAIL in the same forms the review gate accepts", () => {
    expect(lastVerdictIsFail([verdict("PASS"), verdict("FAIL", true)])).toBe(true);
    expect(lastVerdictIsFail([verdict("FAIL")])).toBe(true);
  });

  it("is false when the last verdict passes or there is none", () => {
    expect(lastVerdictIsFail([verdict("FAIL"), verdict("PASS")])).toBe(false);
    expect(lastVerdictIsFail(["just a comment"])).toBe(false);
    expect(lastVerdictIsFail([])).toBe(false);
  });
});
