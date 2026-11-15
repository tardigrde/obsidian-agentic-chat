import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  mineSessionText,
  mineTarget,
  parseMiningArgs,
  runTraceMiner,
  type TraceCandidate,
} from "../scripts/eval/trace-miner";

const SESSION_FILE = "2026-01-02T03-04-05-000Z_trace-fixture.jsonl";
const FIXED_NOW = new Date("2026-01-02T00:00:00.000Z");
const tempRoots: string[] = [];

type JsonEntry = Record<string, unknown>;

interface FixtureOptions {
  timestamp?: string;
  model?: { provider: string; modelId: string };
}

/**
 * Builds the same JSONL shape `src/session/jsonl.ts` writes: a header plus
 * message and action-audit entries chained by parentId. Every value is
 * synthetic; the miner tests never touch a real vault.
 */
class FixtureSession {
  private readonly entries: JsonEntry[] = [];
  private lastId: string | null = null;
  private seq = 0;
  private readonly timestamp: string;

  constructor(options: FixtureOptions = {}) {
    this.timestamp = options.timestamp ?? "2026-01-02T03:04:05.000Z";
    this.entries.push({
      type: "session",
      version: 1,
      id: "session-1",
      timestamp: this.timestamp,
      cwd: "/home/levente/ExampleVault",
    });
    if (options.model) {
      this.add({
        type: "model_change",
        timestamp: this.timestamp,
        provider: options.model.provider,
        modelId: options.model.modelId,
      });
    }
  }

  user(text: string, images = 0, parentId?: string): this {
    const content =
      images > 0
        ? [
            { type: "text", text },
            ...Array.from({ length: images }, () => ({ type: "image", data: "aGVsbG8=", mimeType: "image/png" })),
          ]
        : text;
    return this.message("user", { content }, parentId);
  }

  assistant(parts: {
    text?: string;
    toolCalls?: Array<{ id: string; name: string; args?: Record<string, unknown> }>;
    stopReason?: string;
    errorMessage?: string;
  }): this {
    const content: JsonEntry[] = [];
    if (parts.text) content.push({ type: "text", text: parts.text });
    for (const call of parts.toolCalls ?? []) {
      content.push({ type: "toolCall", id: call.id, name: call.name, arguments: call.args ?? {} });
    }
    const stopReason = parts.stopReason ?? ((parts.toolCalls?.length ?? 0) > 0 ? "toolUse" : "stop");
    return this.message("assistant", {
      content,
      provider: "openrouter",
      model: "test-model",
      stopReason,
      ...(parts.errorMessage ? { errorMessage: parts.errorMessage } : {}),
    });
  }

  toolResult(toolCallId: string, toolName: string, text: string, isError = false): this {
    return this.message("toolResult", {
      toolCallId,
      toolName,
      content: [{ type: "text", text }],
      isError,
      details: {},
    });
  }

  approval(toolName: string, toolCallId: string, decision: string, reason?: string): this {
    return this.add({
      type: "action_audit",
      timestamp: this.timestamp,
      event: {
        category: "approval",
        action: "decision",
        decision,
        toolName,
        toolCallId,
        touchedFiles: [],
        ...(reason ? { reason } : {}),
      },
    });
  }

  auditToolError(toolCallId: string, toolName: string): this {
    return this.add({
      type: "action_audit",
      timestamp: this.timestamp,
      event: {
        category: "tool_call",
        action: "end",
        isError: true,
        toolName,
        toolCallId,
        touchedFiles: [],
      },
    });
  }

  text(): string {
    return `${this.entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  }

  get lastEntryId(): string {
    return this.lastId ?? "";
  }

  private message(role: string, message: JsonEntry, parentId = this.lastId): this {
    return this.add(
      { type: "message", timestamp: this.timestamp, message: { role, timestamp: this.timestamp, ...message } },
      parentId,
    );
  }

  private add(entry: JsonEntry, parentId = this.lastId): this {
    const id = `entry-${(this.seq += 1)}`;
    this.entries.push({ ...entry, id, parentId });
    this.lastId = id;
    return this;
  }
}

function mine(session: FixtureSession): TraceCandidate[] {
  return mineSessionText(session.text(), SESSION_FILE);
}

async function tempDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "agentic-chat-trace-miner-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("mineSessionText", () => {
  it("emits one high candidate for a failed tool result", () => {
    const session = new FixtureSession({ model: { provider: "openrouter", modelId: "test-model" } })
      .user("Open the note.")
      .assistant({ toolCalls: [{ id: "call-1", name: "vault_read", args: { path: "Note.md" } }] })
      .toolResult("call-1", "vault_read", "Error: permission denied", true)
      .assistant({ text: "I could not open it." });

    const candidates = mine(session);

    expect(candidates).toHaveLength(1);
    const [candidate] = candidates;
    expect(candidate).toMatchObject({
      session: SESSION_FILE,
      date: "2026-01-02",
      model: "openrouter/test-model",
      signal: "tool-error",
      severity: "high",
    });
    expect(candidate?.id).toMatch(/^trace-[0-9a-f]{8}-1$/);
    expect(candidate?.toolCalls).toEqual([{ name: "vault_read", isError: true }]);
    expect(candidate?.userTurns).toEqual([{ text: "Open the note.", images: 0 }]);
    expect(candidate?.evidence).toContain("vault_read");
    expect(candidate?.evidence).toContain("permission denied");
    expect(candidate?.replayHint).toContain("vault_read");
  });

  it("uses an action-audit error when the session has no tool result message", () => {
    const session = new FixtureSession()
      .user("Read it.")
      .assistant({ toolCalls: [{ id: "call-1", name: "vault_read", args: { path: "Note.md" } }] })
      .auditToolError("call-1", "vault_read")
      .assistant({ text: "Failed." });

    const candidates = mine(session).filter((candidate) => candidate.signal === "tool-error");

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.toolCalls).toEqual([{ name: "vault_read", isError: true }]);
    expect(candidates[0]?.evidence).toContain("vault_read");
  });

  it("does not double-count an error reported by both the audit log and the tool result", () => {
    const session = new FixtureSession()
      .user("Read it.")
      .assistant({ toolCalls: [{ id: "call-1", name: "vault_read", args: { path: "Note.md" } }] })
      .auditToolError("call-1", "vault_read")
      .toolResult("call-1", "vault_read", "Error: permission denied", true)
      .assistant({ text: "Failed." });

    const errors = mine(session).filter((candidate) => candidate.signal === "tool-error");

    expect(errors).toHaveLength(1);
    expect(errors[0]?.evidence).toContain("permission denied");
  });

  it("flags a user correction after an assistant turn and strips the note body", () => {
    const context =
      '<context>\nThe user attached the following from their vault:\n\nActive note "Private.md":\n\nSECRET NOTE BODY\n</context>';
    const session = new FixtureSession()
      .user(`${context}\n\nFix the heading`, 2)
      .assistant({ text: "Done." })
      .user("No, that is wrong.");

    const candidates = mine(session);

    expect(candidates.map((candidate) => candidate.signal)).toEqual(["user-correction"]);
    expect(candidates[0]?.severity).toBe("medium");
    expect(candidates[0]?.userTurns).toEqual([
      { text: "Fix the heading", images: 2 },
      { text: "No, that is wrong.", images: 0 },
    ]);
    expect(JSON.stringify(candidates)).not.toContain("SECRET NOTE BODY");
  });

  it("flags the same normalized user text twice in a row as a retry", () => {
    const session = new FixtureSession()
      .user("Summarize the note.")
      .assistant({ text: "Here is the summary." })
      .user("Summarize the note.");

    const candidates = mine(session);

    expect(candidates.map((candidate) => candidate.signal)).toEqual(["retry"]);
    expect(candidates[0]?.userTurns.map((turn) => turn.text)).toEqual(["Summarize the note.", "Summarize the note."]);
    expect(candidates[0]?.evidence.toLowerCase()).toContain("repeat");
  });

  it("flags a repeated user text after an error turn as a retry", () => {
    const session = new FixtureSession()
      .user("Summarize the note.")
      .assistant({ text: "", stopReason: "error", errorMessage: "Provider failed." })
      .user("Summarize the note.");

    const candidates = mine(session);

    expect(candidates.map((candidate) => candidate.signal)).toEqual(["retry"]);
    expect(candidates[0]?.evidence.toLowerCase()).toContain("error");
  });

  it("keeps an abandoned failed tool turn so its error stays a candidate", () => {
    const session = new FixtureSession().user("Open the note.");
    const firstUserId = session.lastEntryId;
    session
      .assistant({ toolCalls: [{ id: "call-1", name: "vault_read", args: { path: "Note.md" } }] })
      .toolResult("call-1", "vault_read", "Error: permission denied", true)
      .assistant({ text: "I could not open it." })
      .user("Open the note.", 0, firstUserId)
      .assistant({ text: "Here is the note." });

    const candidates = mine(session);

    expect(candidates.map((candidate) => candidate.signal)).toContain("tool-error");
    expect(candidates.some((candidate) => candidate.signal === "retry")).toBe(true);
  });

  it("flags more than 15 tool calls in one user turn as a long chain", () => {
    const session = new FixtureSession().user("Do all of this.");
    const calls = Array.from({ length: 16 }, (_, index) => ({
      id: `call-${index}`,
      name: "vault_list",
      args: { folder: `Folder ${index}` },
    }));
    session.assistant({ toolCalls: calls });
    for (const [index, call] of calls.entries()) {
      session.toolResult(call.id, call.name, `ok ${index}`);
    }

    const candidates = mine(session);

    expect(candidates.map((candidate) => candidate.signal)).toEqual(["long-chain"]);
    expect(candidates[0]?.toolCalls).toHaveLength(16);
    expect(candidates[0]?.evidence).toContain("16");
  });

  it("emits nothing for a clean session", () => {
    const session = new FixtureSession()
      .user("Hello")
      .assistant({ text: "Hi there." })
      .user("Thanks")
      .assistant({ text: "You are welcome." });

    expect(mine(session)).toEqual([]);
  });

  it("redacts emails, tokens, URL query secrets, and absolute home paths", () => {
    const session = new FixtureSession()
      .user(
        "Email jane.doe@example.com, use sk-abc123def456ghi789 and ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789. " +
          "Fetch https://example.com/hook?token=super-secret-value&page=2 and read /home/levente/Vault/Private.md",
      )
      .assistant({ text: "Done." })
      .user("No, that is wrong.");

    const candidates = mine(session);
    const text = candidates[0]?.userTurns[0]?.text ?? "";
    const serialized = JSON.stringify(candidates);

    expect(text).toContain("[email]");
    expect(text).toContain("[redacted]");
    expect(text).toContain("token=[redacted]");
    expect(text).toContain("/[path]");
    expect(serialized).not.toContain("jane.doe@example.com");
    expect(serialized).not.toContain("sk-abc123def456ghi789");
    expect(serialized).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
    expect(serialized).not.toContain("super-secret-value");
    expect(serialized).not.toContain("/home/levente");
  });

  it("flags a declined approval once per turn", () => {
    const session = new FixtureSession()
      .user("Delete the note.")
      .assistant({ toolCalls: [{ id: "call-1", name: "vault_delete", args: { path: "Note.md" } }] })
      .approval("vault_delete", "call-1", "denied", "User declined the action.")
      .toolResult("call-1", "vault_delete", "User declined the action.", true)
      .assistant({ text: "I did not delete it." });

    const approvals = mine(session).filter((candidate) => candidate.signal.startsWith("approval-"));

    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ signal: "approval-declined", severity: "high" });
    expect(approvals[0]?.evidence).toContain("vault_delete");
  });

  it("flags a stopped approval once per turn", () => {
    const session = new FixtureSession()
      .user("Edit the note.")
      .assistant({ toolCalls: [{ id: "call-1", name: "vault_edit", args: { path: "Note.md" } }] })
      .approval("vault_edit", "call-1", "denied", "The turn was stopped before approval.")
      .toolResult("call-1", "vault_edit", "Operation aborted", true)
      .assistant({ text: "Stopped." });

    const approvals = mine(session).filter((candidate) => candidate.signal.startsWith("approval-"));

    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ signal: "approval-stopped", severity: "high" });
    expect(approvals[0]?.evidence).toContain("vault_edit");
  });

  it("flags a known recovery signal from a non-error tool result", () => {
    const session = new FixtureSession()
      .user("Check the folder.")
      .assistant({ toolCalls: [{ id: "call-1", name: "vault_list", args: { folder: "Missing" } }] })
      .toolResult("call-1", "vault_list", "File not found: Missing", false)
      .assistant({ text: "The folder does not exist." });

    const candidates = mine(session);

    expect(candidates.map((candidate) => candidate.signal)).toEqual(["recovery-signal"]);
    expect(candidates[0]?.severity).toBe("low");
    expect(candidates[0]?.evidence).toContain("File not found");
  });

  it("flags the same tool call with identical arguments three times", () => {
    const session = new FixtureSession().user("List the folder until it works.");
    for (let index = 0; index < 3; index += 1) {
      session.assistant({ toolCalls: [{ id: `call-${index}`, name: "vault_list", args: { folder: "Notes" } }] });
      session.toolResult(`call-${index}`, "vault_list", "a.md\nb.md", false);
    }

    const candidates = mine(session);

    expect(candidates.map((candidate) => candidate.signal)).toEqual(["repeated-tool-call"]);
    expect(candidates[0]?.evidence).toContain("vault_list");
    expect(candidates[0]?.evidence).toContain("3");
  });
});

describe("privacy regressions", () => {
  it("strips note lines and the oldText payload from an edit error", () => {
    const errorText = [
      'oldText was not found: "The secret line from the note"',
      "Closest match (line 12): PRIVATE NOTE LINE",
      "Next closest (line 20): ANOTHER PRIVATE LINE",
    ].join("\n");
    const session = new FixtureSession()
      .user("Fix the heading.")
      .assistant({ toolCalls: [{ id: "call-1", name: "vault_edit", args: { path: "Note.md" } }] })
      .toolResult("call-1", "vault_edit", errorText, true)
      .assistant({ text: "I could not edit it." });

    const [candidate] = mine(session);
    const evidence = candidate?.evidence ?? "";

    expect(candidate?.signal).toBe("tool-error");
    expect(evidence).toContain("vault_edit");
    expect(evidence).toContain("oldText was not found");
    expect(evidence).toContain("[oldText]");
    expect(evidence).not.toContain("The secret line from the note");
    expect(evidence).not.toContain("PRIVATE NOTE LINE");
    expect(evidence).not.toContain("ANOTHER PRIVATE LINE");
    expect(evidence).not.toContain("Closest match");
    expect(evidence).not.toContain("Next closest");
  });

  it("strips the oldText payload from a must-match-exactly-once edit error", () => {
    const errorText = 'oldText must match exactly once: "The secret duplicated line"';
    const session = new FixtureSession()
      .user("Fix the heading.")
      .assistant({ toolCalls: [{ id: "call-1", name: "vault_edit", args: { path: "Note.md" } }] })
      .toolResult("call-1", "vault_edit", errorText, true)
      .assistant({ text: "I could not edit it." });

    const [candidate] = mine(session);
    const evidence = candidate?.evidence ?? "";

    expect(candidate?.signal).toBe("tool-error");
    expect(evidence).toContain("oldText must match exactly once");
    expect(evidence).toContain("[oldText]");
    expect(evidence).not.toContain("The secret duplicated line");
  });

  it("strips a compressed context marker and its attached path list", () => {
    const marker =
      "<context unchanged since previous turn. Attached: Private/Diary.md, Private/Keys.md. " +
      "Use the read tool to open any attached note if you need the full content.</context>";
    const session = new FixtureSession()
      .user(`${marker}\n\nRename the heading.`)
      .assistant({ text: "Done." })
      .user("No, that is wrong.");

    const candidates = mine(session);
    const text = candidates[0]?.userTurns[0]?.text ?? "";

    expect(text).toBe("Rename the heading.");
    expect(JSON.stringify(candidates)).not.toContain("Private/");
    expect(JSON.stringify(candidates)).not.toContain("Attached:");
  });

  it("redacts dot-segment home paths and every URL query value", () => {
    const session = new FixtureSession()
      .user(
        "Read /root/.ssh/id_rsa and /home/jane/.config/secret, then open https://example.com/?q=diary",
      )
      .assistant({ text: "Done." })
      .user("No, that is wrong.");

    const candidates = mine(session);
    const text = candidates[0]?.userTurns[0]?.text ?? "";
    const serialized = JSON.stringify(candidates);

    expect(text).toContain("/[path]");
    expect(text).toContain("q=[redacted]");
    expect(serialized).not.toContain("/root/.ssh");
    expect(serialized).not.toContain("id_rsa");
    expect(serialized).not.toContain("jane");
    expect(serialized).not.toContain("diary");
  });
});

describe("file target guard", () => {
  it("rejects a non-.jsonl file before reading its content", async () => {
    const dir = await tempDir();
    const envFile = path.join(dir, ".env");
    const txtFile = path.join(dir, "notes.txt");
    const envSecret = "sk-live-secret-value-123456789";
    const txtSecret = "PRIVATE TXT CONTENT";
    await writeFile(envFile, `API_KEY=${envSecret}\n`);
    await writeFile(txtFile, `${txtSecret}\n`);

    for (const [file, secret] of [
      [envFile, envSecret],
      [txtFile, txtSecret],
    ] as const) {
      let message = "";
      try {
        mineTarget(file);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toMatch(/non-\.jsonl/);
      expect(message).not.toContain(secret);
    }
  });
});

describe("runTraceMiner", () => {
  it("writes candidates.json and report.md and applies --max", async () => {
    const session = new FixtureSession();
    for (const name of ["A", "B", "C"]) {
      session
        .user(`Open note ${name}.`)
        .assistant({ toolCalls: [{ id: `call-${name}`, name: "vault_read", args: { path: `${name}.md` } }] })
        .toolResult(`call-${name}`, "vault_read", `Error: ${name} failed`, true)
        .assistant({ text: "Failed." });
    }
    const sessionsDir = await tempDir();
    const outDir = await tempDir();
    await writeFile(path.join(sessionsDir, SESSION_FILE), session.text());

    const result = await runTraceMiner({ sessions: sessionsDir, out: outDir, max: 2, now: FIXED_NOW });

    expect(result.sessions).toBe(1);
    expect(result.minedCount).toBe(3);
    expect(result.candidates).toHaveLength(2);
    const written = JSON.parse(await readFile(path.join(outDir, "candidates.json"), "utf8")) as unknown[];
    expect(written).toHaveLength(2);
    const report = await readFile(path.join(outDir, "report.md"), "utf8");
    expect(report).toContain("- Candidates: 2");
    expect(report).toContain("- Sessions scanned: 1");
    expect(report).toContain("## Counts by signal");
    expect(report).toContain("tool-error");
  });
});

describe("parseMiningArgs", () => {
  it("requires --sessions and validates --max", () => {
    expect(() => parseMiningArgs([])).toThrow(/--sessions/);
    expect(parseMiningArgs(["--sessions", "/tmp/sessions", "--max", "5"])).toMatchObject({
      sessions: "/tmp/sessions",
      max: 5,
    });
    expect(parseMiningArgs(["--sessions", "/tmp/sessions", "--out", "/tmp/out"])).toMatchObject({
      sessions: "/tmp/sessions",
      out: "/tmp/out",
    });
    expect(() => parseMiningArgs(["--sessions", "/tmp/sessions", "--max", "0"])).toThrow(/--max/);
    expect(() => parseMiningArgs(["--max", "5"])).toThrow(/--sessions/);
  });
});
