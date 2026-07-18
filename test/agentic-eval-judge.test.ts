import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  buildJudgePacket,
  judgeCacheKey,
  judgePrompt,
  parseJudgeVerdict,
  resolveJudgeConfig,
  runJudge,
  type JudgeRunResult,
} from "../scripts/agentic-eval-judge";
import type { DogfoodManifest } from "../scripts/dogfood-core";

describe("agentic eval judge", () => {
  it("loads judge config from .env without requiring process env", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "agentic-judge-env-"));
    await writeFile(
      path.join(cwd, ".env"),
      [
        "AGENTIC_EVAL_JUDGE_BASE_URL=https://judge.example/api",
        "AGENTIC_EVAL_JUDGE_MODEL=judge/model",
        "AGENTIC_EVAL_JUDGE_API_KEY=dummy-key",
        "AGENTIC_EVAL_JUDGE_HTTPS_PROXY=http://proxy.example:3128",
      ].join("\n"),
      "utf8",
    );

    const result = await resolveJudgeConfig({ cwd, env: {} });

    expect(result.config).toEqual(
      expect.objectContaining({
        baseUrl: "https://judge.example/api",
        model: "judge/model",
        apiKey: "dummy-key",
        proxyUrl: "http://proxy.example:3128",
      }),
    );
    expect(result.redacted).toEqual(
      expect.objectContaining({
        configured: true,
        hasApiKey: true,
        hasProxy: true,
      }),
    );
  });

  it("parses fenced judge JSON", () => {
    const verdict = parseJudgeVerdict(`\`\`\`json
{"overallScore":4.2,"pass":true,"summary":"Good run.","scores":{"taskCompletion":5,"groundedness":4},"strengths":["safe"],"issues":["terse"],"promptRecommendations":["be more explicit"]}
\`\`\``);

    expect(verdict.overallScore).toBe(4.2);
    expect(verdict.scores.groundedness).toBe(4);
    expect(verdict.promptRecommendations).toEqual(["be more explicit"]);
  });

  it("builds a compact judge packet from dogfood artifacts", async () => {
    const runDir = await mkdtemp(path.join(tmpdir(), "agentic-judge-run-"));
    const sessionDir = path.join(runDir, "vault", ".obsidian", "plugins", "agentic-chat", "sessions");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      path.join(sessionDir, "session.jsonl"),
      [
        JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "Create notes." }] } }),
        JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Done." }] } }),
        JSON.stringify({
          type: "action_audit",
          event: { category: "approval", action: "decision", decision: "denied", toolName: "write", reason: "no" },
        }),
      ].join("\n"),
      "utf8",
    );
    await mkdir(path.join(runDir, "vault", "Generated"), { recursive: true });
    await writeFile(path.join(runDir, "vault", "Generated", "Oracle.md"), "# Oracle\nUseful note.\n", "utf8");
    const manifest: DogfoodManifest = {
      version: 1,
      runId: "run",
      createdAt: "2026-07-01T00:00:00.000Z",
      vaultPath: path.join(runDir, "vault"),
      externalRoot: path.join(runDir, "external"),
      secretText: "secret",
      expectedActiveNote: "Dogfood Scratch.md",
      ignoredGlobs: [],
      allowedMutationRoots: [],
      deniedMutationPaths: [],
      requiredTools: [],
      requiredGeneratedNotes: [{ path: "Generated/Oracle.md", frontmatter: false, requiredSubstrings: [] }],
      repeatedExternalReads: [],
      maxUserMessageChars: 1000,
    };

    const packet = await buildJudgePacket({
      caseId: "judge",
      dogfoodRunId: "run",
      runDir,
      manifest,
      snapshot: { dogfoodRunId: "run", runDir, invariant: { ok: true, findings: [], metrics: {} } },
    });

    expect(packet.conversation.userPrompts).toEqual(["Create notes."]);
    expect(packet.conversation.assistantResponses).toEqual(["Done."]);
    expect(packet.generatedNotes[0]).toEqual(expect.objectContaining({ path: "Generated/Oracle.md" }));
    expect(packet.trace.approvalDenials).toEqual([{ key: "write: no", count: 1 }]);
    expect(packet.promptContext.defaultSystemPromptExcerpt).toContain("read_skill");
    expect(packet.promptContext.externalWorkspaceOverlay).toContain("Avoid repeating the same external_inspect");
    expect(packet.promptContext.externalWorkspaceOverlay).toContain("one exact repeat is enough");
    expect(packet.promptContext.relevantToolDescriptions.external_inspect).toContain("reuse prior output");
    expect(packet.promptContext.relevantToolDescriptions.external_inspect).toContain("do it once");
  });

  it("returns cached judge results without making a provider request", async () => {
    const cacheDir = await mkdtemp(path.join(tmpdir(), "agentic-judge-cache-"));
    const packet = {
      version: 1 as const,
      caseId: "judge",
      dogfoodRunId: "run",
      objective: "judge",
      deterministic: { invariantOk: true, invariantFindings: [], metrics: {}, knownIntentionalNoise: [] },
      conversation: { userPrompts: [], assistantResponses: [] },
      generatedNotes: [],
      trace: { duplicateToolStarts: [], repeatedExternalPathActions: [], approvalDenials: [] },
      promptContext: { defaultSystemPromptExcerpt: "", externalWorkspaceOverlay: "", relevantToolDescriptions: {} },
      rubric: [],
    };
    const prompt = judgePrompt(packet);
    const cacheKey = judgeCacheKey({ model: "judge/model", prompt });
    const cached: JudgeRunResult = {
      cacheHit: false,
      cacheKey,
      packet,
      rawResponse: "{}",
      verdict: {
        overallScore: 5,
        pass: true,
        summary: "Cached.",
        scores: { taskCompletion: 5 },
        strengths: [],
        issues: [],
        promptRecommendations: [],
      },
    };
    await writeFile(path.join(cacheDir, `${cacheKey}.json`), `${JSON.stringify(cached)}\n`, "utf8");

    const result = await runJudge({
      cacheDir,
      packet,
      config: { baseUrl: "http://unused", apiKey: "unused", model: "judge/model", timeoutMs: 1000, maxTokens: 100 },
    });

    expect(result.cacheHit).toBe(true);
    expect(result.verdict.summary).toBe("Cached.");
  });
});
