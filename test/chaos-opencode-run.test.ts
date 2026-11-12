import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { chatComplete } from "../scripts/chaos/explorer-llm";
import { childEnv, opencodeComplete, qualifiedModel, parseOpencodeOutput, serializeMessages } from "../scripts/chaos/opencode-run";

const savedBin = process.env.OPENCODE_BIN;
const savedCounter = process.env.CHAOS_FAKE_COUNTER;
const dirs: string[] = [];

function fakeBin(script: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "chaos-opencode-"));
  dirs.push(dir);
  const file = path.join(dir, "fake-opencode");
  writeFileSync(file, `#!/usr/bin/env node\n${script}\n`);
  chmodSync(file, 0o755);
  return file;
}

const okScript = `
process.stdin.setEncoding("utf8");
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const reply = JSON.stringify({ stdin: input.length, argv: process.argv.slice(2).join(" "), cwd: process.cwd(), config: process.env.OPENCODE_CONFIG_CONTENT ?? "", leaked: Boolean(process.env.AGENTIC_CHAT_API_KEY) });
  process.stdout.write(JSON.stringify({ type: "step_start", sessionID: "ses_x", part: { type: "step-start" } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "text", sessionID: "ses_x", part: { type: "text", text: reply } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "step_finish", sessionID: "ses_x", part: { type: "step-finish", reason: "stop", cost: 0, tokens: { input: 985, output: 7, reasoning: 0, cache: { read: 0, write: 0 } } } }) + "\\n");
});
`;

afterEach(() => {
  if (savedBin === undefined) delete process.env.OPENCODE_BIN;
  else process.env.OPENCODE_BIN = savedBin;
  if (savedCounter === undefined) delete process.env.CHAOS_FAKE_COUNTER;
  else process.env.CHAOS_FAKE_COUNTER = savedCounter;
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe("opencode prompt serialization", () => {
  const messages = [
    { role: "user" as const, content: "first question" },
    { role: "system" as const, content: "be terse" },
    { role: "assistant" as const, content: "an answer" },
    { role: "user" as const, content: "second question" },
  ];

  it("puts system text first, then the turns in order", () => {
    const text = serializeMessages(messages, false);
    expect(text.startsWith("# Instructions")).toBe(true);
    expect(text).toContain("## user\n\nfirst question");
    expect(text).toContain("## assistant\n\nan answer");
    expect(text).toContain("## user\n\nsecond question");
    expect(text.indexOf("# Instructions")).toBeLessThan(text.indexOf("## user"));
    expect(text.indexOf("first question")).toBeLessThan(text.indexOf("an answer"));
    expect(text.indexOf("an answer")).toBeLessThan(text.indexOf("second question"));
    expect(text).not.toContain("Reply with one JSON object only");
  });

  it("adds the JSON line only when json is true", () => {
    const text = serializeMessages(messages, true);
    expect(text.trimEnd().endsWith("Reply with one JSON object only. No prose, no code fence.")).toBe(true);
    expect(text.match(/Reply with one JSON object only/g)).toHaveLength(1);
  });
});

describe("opencode output parser", () => {
  const example = [
    '{"type":"step_start","sessionID":"ses_x","part":{"type":"step-start"}}',
    '{"type":"text","sessionID":"ses_x","part":{"type":"text","text":"{\\"ok\\":true}"}}',
    '{"type":"step_finish","sessionID":"ses_x","part":{"type":"step-finish","reason":"stop","cost":0,"tokens":{"input":985,"output":7,"reasoning":0,"cache":{"read":0,"write":0}}}}',
  ].join("\n");

  it("reads text, usage, and the finish reason from JSON lines", () => {
    const reply = parseOpencodeOutput(example, "opencode-go/deepseek-v4.1-flash");
    expect(reply.text).toBe('{"ok":true}');
    expect(reply.usage).toEqual({ promptTokens: 985, completionTokens: 7, totalTokens: 992, cost: 0 });
    expect(reply.finishReason).toBe("stop");
    expect(reply.model).toBe("opencode-go/deepseek-v4.1-flash");
  });

  it("sums two step_finish lines and skips garbage", () => {
    const stdout = [
      "not json at all",
      "",
      '{"type":"text","part":{"type":"text","text":"a"}}',
      '{"type":"text","part":{"type":"text","text":"b"}}',
      '{"type":"step_finish","part":{"type":"step-finish","reason":"tool-calls","cost":0.5,"tokens":{"input":10,"output":2,"reasoning":1,"cache":{"read":5,"write":0}}}}',
      '{"type":"step_finish","part":{"type":"step-finish","reason":"stop","cost":0.25,"tokens":{"input":100,"output":20,"reasoning":0,"cache":{"read":0,"write":0}}}}',
    ].join("\n");
    const reply = parseOpencodeOutput(stdout, "m");
    expect(reply.text).toBe("ab");
    expect(reply.usage).toEqual({ promptTokens: 115, completionTokens: 23, totalTokens: 138, cost: 0.75 });
    expect(reply.finishReason).toBe("stop");
  });

  it("throws on an error line, with the message when present", () => {
    const stdout = '{"type":"error","error":{"message":"model overloaded"}}';
    expect(() => parseOpencodeOutput(stdout, "m")).toThrow("opencode error: model overloaded");
    expect(() => parseOpencodeOutput('{"type":"error","part":{"error":"bad"}}', "m")).toThrow("opencode error: bad");
  });

  it("throws when no text arrives", () => {
    expect(() => parseOpencodeOutput('{"type":"step_finish","part":{"reason":"stop"}}', "m")).toThrow(
      /no text/,
    );
  });
});

describe("opencodeComplete", () => {
  it("runs the agent with stdin and reads the reply", async () => {
    process.env.OPENCODE_BIN = fakeBin(okScript);
    const savedKey = process.env.AGENTIC_CHAT_API_KEY;
    process.env.AGENTIC_CHAT_API_KEY = "sk-or-test-not-for-the-child";
    onTestFinished(() => {
      if (savedKey === undefined) delete process.env.AGENTIC_CHAT_API_KEY;
      else process.env.AGENTIC_CHAT_API_KEY = savedKey;
    });
    const messages = [
      { role: "system" as const, content: "system text" },
      { role: "user" as const, content: "hello" },
    ];
    const reply = await opencodeComplete(
      {
        baseUrl: "opencode://run",
        apiKey: "",
        model: "deepseek-v4.1-flash",
        messages,
        json: true,
        timeoutMs: 10_000,
      },
      1,
    );
    const body = JSON.parse(reply.text) as { stdin: number; argv: string; cwd: string; config: string; leaked: boolean };
    expect(body.argv).toContain("--standalone");
    expect(JSON.parse(body.config).agent["chaos-llm"].tools).toEqual({ "*": false });
    expect(path.relative(process.cwd(), body.cwd).startsWith("..")).toBe(true);
    expect(body.leaked).toBe(false);
    expect(body.stdin).toBe(serializeMessages(messages, true).length);
    expect(body.argv).toContain("--agent chaos-llm");
    expect(body.argv).toContain("-m opencode-go/deepseek-v4.1-flash");
    expect(body.argv).toContain("--format json");
    expect(reply.usage.totalTokens).toBe(992);
    expect(reply.finishReason).toBe("stop");
  });

  it("retries once after a failed attempt", async () => {
    const counter = path.join(mkdtempSync(path.join(os.tmpdir(), "chaos-opencode-counter-")), "count");
    dirs.push(path.dirname(counter));
    process.env.CHAOS_FAKE_COUNTER = counter;
    process.env.OPENCODE_BIN = fakeBin(`
const fs = require("node:fs");
const file = process.env.CHAOS_FAKE_COUNTER;
const count = fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) : 0;
fs.writeFileSync(file, String(count + 1));
if (count === 0) { process.stderr.write("first call fails\\n"); process.exit(1); }
process.stdout.write(JSON.stringify({ type: "text", part: { type: "text", text: "{\\"ok\\":true}" } }) + "\\n");
`);
    const reply = await opencodeComplete(
      { baseUrl: "opencode://run", apiKey: "", model: "opencode-go/deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }], timeoutMs: 10_000 },
      2,
    );
    expect(reply.text).toBe('{"ok":true}');
  });

  it("throws with the exit code after the last attempt", async () => {
    process.env.OPENCODE_BIN = fakeBin('process.stderr.write("always broken"); process.exit(1);');
    await expect(
      opencodeComplete(
        { baseUrl: "opencode://run", apiKey: "", model: "opencode-go/deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }], timeoutMs: 10_000 },
        2,
      ),
    ).rejects.toThrow(/code 1/);
  });

  it("dispatches chatComplete with backend opencode to the CLI", async () => {
    process.env.OPENCODE_BIN = fakeBin(okScript);
    const reply = await chatComplete({
      baseUrl: "https://example.invalid/api",
      apiKey: "",
      model: "opencode-go/deepseek-v4.1-flash",
      backend: "opencode",
      json: true,
      messages: [{ role: "user", content: "hi" }],
      timeoutMs: 10_000,
    });
    expect(reply.usage.totalTokens).toBe(992);
    expect(JSON.parse(reply.text).argv).toContain("--agent chaos-llm");
  });
});

describe("opencode child env", () => {
  it("drops API keys and plugin settings but keeps PATH and HOME", () => {
    const env = childEnv({
      PATH: "/usr/bin",
      HOME: "/home/x",
      AGENTIC_CHAT_API_KEY: "sk-or-secret",
      AGENTIC_CHAT_BASE_URL: "https://openrouter.ai/api/v1",
      OPENCODE_GO_API_KEY: "go-secret",
      GITHUB_TOKEN: "ghp-secret",
      OPENCODE_BIN: "/tmp/fake",
    });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/x", OPENCODE_BIN: "/tmp/fake" });
  });
});

describe("opencode model id", () => {
  it("keeps opencode providers and maps other ids to opencode-go", () => {
    expect(qualifiedModel("opencode-go/deepseek-v4.1-flash")).toBe("opencode-go/deepseek-v4.1-flash");
    expect(qualifiedModel("opencode/some-model")).toBe("opencode/some-model");
    expect(qualifiedModel("deepseek-v4.1-flash")).toBe("opencode-go/deepseek-v4.1-flash");
    expect(qualifiedModel("deepseek/deepseek-v4.1-flash")).toBe("opencode-go/deepseek-v4.1-flash");
  });
});
