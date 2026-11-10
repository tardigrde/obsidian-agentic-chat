import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as gateModule from "../scripts/check-review-gate.mjs";
import {
  isGeneratedFile,
  parseVerdict,
  reviewGate,
  sizeErrors,
} from "../scripts/check-review-gate.mjs";

const HEAD = "1234567890abcdef1234567890abcdef12345678";

function verdictBody(head = HEAD, verdict = "PASS", reviewer = "reviewer-agent") {
  return [
    `Verdict: ${verdict}`,
    `Head: ${head}`,
    `Reviewer: ${reviewer}`,
    "Fast lane: PASS (1702 passed, 173 files)",
  ].join("\n");
}

function comment(
  author: string,
  body: string,
  createdAt = "2026-11-06T12:00:00Z",
  extra: Record<string, unknown> = {},
) {
  return {
    author,
    body,
    createdAt,
    updatedAt: createdAt,
    authorAssociation: "OWNER",
    ...extra,
  };
}

function gate(overrides: Record<string, unknown> = {}) {
  return reviewGate({
    comments: [comment("reviewer", verdictBody())],
    author: "owner",
    headSha: HEAD,
    changedLines: 20,
    changedFiles: 2,
    ...overrides,
  });
}

describe("check-review-gate", () => {
  it("accepts an independent PASS at the current head", () => {
    expect(gate()).toMatchObject({
      ok: true,
      errors: [],
      verdict: "PASS",
      reviewer: "reviewer-agent",
      commentsAtHead: 1,
    });
  });

  it("accepts PASS+NOTES and an abbreviated head", () => {
    expect(
      gate({
        comments: [comment("reviewer", verdictBody(HEAD.slice(0, 7), "PASS+NOTES"))],
      }),
    ).toMatchObject({ ok: true, verdict: "PASS+NOTES" });
  });

  it("requires a verdict at the current head", () => {
    const stale = gate({ comments: [comment("reviewer", verdictBody("abcdef1234567890"))] });
    expect(stale.ok).toBe(false);
    expect(stale.errors.join("\n")).toContain("no verdict at head 1234567");
  });

  it("rejects a FAIL verdict", () => {
    const failed = gate({ comments: [comment("reviewer", verdictBody(HEAD, "FAIL"))] });
    expect(failed.ok).toBe(false);
    expect(failed.errors.join("\n")).toContain("a FAIL verdict at this head by reviewer-agent is not cleared");
  });

  it("ignores the author's own verdict unless the repo is single-account", () => {
    const self = gate({ author: "owner", comments: [comment("owner", verdictBody())] });
    expect(self.ok).toBe(false);
    expect(self.errors.join("\n")).toContain("no verdict at head");
    expect(
      gate({
        author: "owner",
        comments: [comment("owner", verdictBody())],
        singleAccount: true,
      }),
    ).toMatchObject({ ok: true });
  });

  it("requires Reviewer and Fast lane fields", () => {
    expect(parseVerdict("Verdict: PASS\nHead: abcdef1234567890")).toBeNull();
    expect(
      parseVerdict("Verdict: PASS\nHead: abcdef1234567890\nReviewer: x"),
    ).toBeNull();
    expect(
      parseVerdict(
        "**Verdict: PASS**\n**Head: `abcdef1234567890`**\n**Reviewer: x**\n**Fast lane: PASS (12 passed, 3 files)**",
      ),
    ).toMatchObject({ verdict: "PASS", head: "abcdef1234567890", reviewer: "x" });
  });

  it("uses the latest verdict at the same head", () => {
    const result = gate({
      comments: [
        comment("reviewer", verdictBody(), "2026-11-06T12:00:00Z"),
        comment("reviewer", verdictBody(HEAD, "FAIL"), "2026-11-06T12:05:00Z"),
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.verdict).toBe("FAIL");
  });

  it("ignores verdicts from accounts without a trusted association", () => {
    for (const association of ["NONE", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", undefined]) {
      const stranger = gate({
        singleAccount: true,
        comments: [comment("stranger", verdictBody(), undefined, { authorAssociation: association })],
      });
      expect(stranger.ok).toBe(false);
      expect(stranger.errors.join("\n")).toContain("no verdict at head");
    }
    for (const association of ["OWNER", "MEMBER", "COLLABORATOR"]) {
      expect(
        gate({ comments: [comment("reviewer", verdictBody(), undefined, { authorAssociation: association })] }).ok,
      ).toBe(true);
    }
  });

  it("ignores bot accounts even with a trusted association", () => {
    const bot = gate({
      comments: [comment("github-actions[bot]", verdictBody(), undefined, { authorType: "Bot" })],
    });
    expect(bot.ok).toBe(false);
  });

  it("keeps a FAIL sticky against a later PASS from the same Reviewer", () => {
    const result = gate({
      singleAccount: true,
      comments: [
        comment("owner", verdictBody(HEAD, "FAIL", "reviewer-agent"), "2026-11-06T12:00:00Z"),
        comment("owner", verdictBody(HEAD, "PASS", "reviewer-agent"), "2026-11-06T12:05:00Z"),
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.verdict).toBe("FAIL");
  });

  it("clears a FAIL with a later PASS from a different Reviewer", () => {
    const result = gate({
      comments: [
        comment("reviewer", verdictBody(HEAD, "FAIL", "reviewer-agent"), "2026-11-06T12:00:00Z"),
        comment("reviewer", verdictBody(HEAD, "PASS+NOTES", "second-reviewer"), "2026-11-06T12:05:00Z"),
      ],
    });
    expect(result).toMatchObject({ ok: true, verdict: "PASS+NOTES", reviewer: "second-reviewer" });
  });

  it("orders verdicts by creation time, so editing an old PASS does not clear a FAIL", () => {
    const result = gate({
      comments: [
        comment("reviewer", verdictBody(HEAD, "PASS", "second-reviewer"), "2026-11-06T12:00:00Z", {
          updatedAt: "2026-11-06T12:10:00Z",
        }),
        comment("reviewer", verdictBody(HEAD, "FAIL", "reviewer-agent"), "2026-11-06T12:05:00Z"),
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.verdict).toBe("FAIL");
  });

  it("requires a test count in Fast lane", () => {
    const base = "Verdict: PASS\nHead: abcdef1234567890\nReviewer: x\n";
    expect(parseVerdict(`${base}Fast lane: lol`)).toBeNull();
    expect(parseVerdict(`${base}Fast lane: PASS`)).toBeNull();
    expect(parseVerdict(`${base}Fast lane: PASS (0 files passed)`)).toBeNull();
    expect(parseVerdict(`${base}Fast lane: PASS (1702 passed, 173 files)`)).toMatchObject({
      verdict: "PASS",
    });
    expect(gate({ comments: [comment("reviewer", `${base.replace("abcdef1234567890", HEAD)}Fast lane: lol`)] }).ok).toBe(
      false,
    );
  });

  it("enforces the size limit and allows the large-pr override", () => {
    expect(sizeErrors({ changedLines: 401, changedFiles: 3 })).toHaveLength(1);
    expect(sizeErrors({ changedLines: 20, changedFiles: 11 })).toHaveLength(1);
    expect(sizeErrors({ changedLines: 20, changedFiles: 11, labels: ["large-pr"] })).toEqual([]);
    expect(gate({ changedLines: 401 }).ok).toBe(false);
    expect(gate({ changedLines: 401, labels: ["large-pr"] }).ok).toBe(true);
  });

  it("exposes the src/ budget helpers (#288)", () => {
    // An assertion, not a TypeError, when the helpers are missing.
    expect(typeof gateModule.measureNumstat).toBe("function");
    expect(typeof gateModule.readNumstat).toBe("function");
  });

  it("counts only added lines in src/ toward the budget (#288)", () => {
    const record = (added: string, deleted: string, path: string) => `${added}\t${deleted}\t${path}\0`;
    const rename = (added: string, from: string, to: string) => `${added}\t0\t\0${from}\0${to}\0`;
    const numstat = [
      record("30", "5", "src/agent/a.ts"),
      record("0", "900", "src/old-feature.ts"), // pure deletion: free
      record("500", "0", "docs/development/guide.md"), // docs: free
      record("300", "0", "test/a.test.ts"), // tests: free
      record("200", "0", ".agents/skills/x/features/map.md"), // skills: free
      record("4000", "10", "package-lock.json"),
      record("-", "-", "src/icon.png"), // binary
      rename("7", "src/old/b.ts", "src/new/b.ts"), // rename inside src
      rename("12", "lib/c.ts", "src/c.ts"), // moved into src
      rename("9", "src/d.ts", "lib/d.ts"), // moved out of src
      rename("4", "logs/e.ts", "src/e.ts"), // from a generated path into src
      record("6", "0", "src/café.ts"), // non-ASCII
      record("3", "0", "src/a => b.ts"), // ` => ` inside a real name
      record("2", "0", "src/tab\tname.ts"), // tab inside a name
    ].join("");
    expect(gateModule.measureNumstat(numstat)).toEqual({ changedLines: 64, changedFiles: 7 });
    expect(gateModule.measureNumstat(record("0", "900", "src/a.ts") + record("0", "50", "src/b.ts"))).toEqual({
      changedLines: 0,
      changedFiles: 0,
    });
    expect(gateModule.measureNumstat(record("401", "0", "src/a.ts"))).toEqual({ changedLines: 401, changedFiles: 1 });
  });

  it("measures a real git diff with renames and unusual names (#288)", () => {
    const repo = mkdtempSync(path.join(tmpdir(), "review-gate-numstat-"));
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args], {
        cwd: repo,
        encoding: "utf8",
      }).trim();
    try {
      git("init", "-q", "-b", "main");
      mkdirSync(path.join(repo, "src"));
      mkdirSync(path.join(repo, "lib"));
      writeFileSync(path.join(repo, "lib", "moved.ts"), Array.from({ length: 20 }, (_, i) => `export const v${i} = ${i};`).join("\n"));
      writeFileSync(path.join(repo, "src", "old.ts"), "a\nb\nc\n");
      git("add", "-A");
      git("commit", "-q", "-m", "base");
      const base = git("rev-parse", "HEAD");
      git("mv", "lib/moved.ts", "src/moved.ts");
      writeFileSync(path.join(repo, "src", "moved.ts"), `${readFileSync(path.join(repo, "src", "moved.ts"), "utf8")}\nexport const extra = 1;\n`);
      writeFileSync(path.join(repo, "src", "café.ts"), "1\n2\n");
      writeFileSync(path.join(repo, "src", "a => b.ts"), "1\n");
      writeFileSync(path.join(repo, "docs.md"), "x\n".repeat(50));
      git("rm", "-q", "src/old.ts");
      git("add", "-A");
      git("commit", "-q", "-m", "head");
      const head = git("rev-parse", "HEAD");

      const size = gateModule.measureNumstat(gateModule.readNumstat(base, head, repo));
      // moved.ts: +2 (blank + extra); café.ts: +2; "a => b.ts": +1; docs and the deletion are free.
      expect(size).toEqual({ changedLines: 5, changedFiles: 3 });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("excludes generated files from the size count", () => {
    expect(isGeneratedFile("package-lock.json")).toBe(true);
    expect(isGeneratedFile("docs/package-lock.json")).toBe(false);
    expect(isGeneratedFile("main.min.js")).toBe(true);
    expect(isGeneratedFile("src/main.ts")).toBe(false);
  });
});
