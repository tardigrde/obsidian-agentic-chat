import { describe, expect, it } from "vitest";
import { containsSensitiveText, redactJsonl, redactText, redactValue } from "../src/privacy/redaction";

describe("privacy redaction", () => {
  it("redacts common secret forms in text previews", () => {
    const redacted = redactText("api_key=hidden Bearer supersecrettoken sk-live-secret-value", {
      redactHighEntropy: true,
    });

    expect(redacted).toContain("api_key=[redacted]");
    expect(redacted).toContain("Bearer [redacted]");
    expect(redacted).not.toContain("hidden");
    expect(redacted).not.toContain("supersecrettoken");
    expect(redacted).not.toContain("sk-live-secret-value");
  });

  it("redacts quoted assignment secrets before truncating previews", () => {
    const redacted = redactText(`api_key="quoted secret" password: 'abc def' access_token="tok-123"`, {
      redactHighEntropy: true,
    });

    expect(redacted).toContain("api_key=[redacted]");
    expect(redacted).toContain("password=[redacted]");
    expect(redacted).toContain("access_token=[redacted]");
    expect(redacted).not.toContain("quoted secret");
    expect(redacted).not.toContain("abc def");
    expect(redacted).not.toContain("tok-123");
  });

  it("redacts structured secret keys and summarizes content payloads", () => {
    expect(
      redactValue(
        {
          authorization: "Bearer secret-token",
          nested: { refreshToken: "refresh-secret" },
          content: [{ type: "text", text: "full transcript should not appear" }],
          safe: "hello",
        },
        { summarizeContent: true },
      ),
    ).toEqual({
      authorization: "[redacted]",
      nested: { refreshToken: "[redacted]" },
      content: "[content array 1 items]",
      safe: "hello",
    });
  });

  it("redacts session JSONL without leaking transcript text", () => {
    const raw = `${JSON.stringify({
      type: "message",
      message: {
        role: "user",
        content: [{ type: "text", text: "private prompt api_key=hidden" }],
      },
      result: { token: "result-secret" },
    })}\nnot-json Bearer supersecrettoken\n`;

    const redacted = redactJsonl(raw, { summarizeContent: true, redactHighEntropy: true });

    expect(redacted).toContain("[content array 1 items]");
    expect(redacted).toContain("Bearer [redacted]");
    expect(redacted).not.toContain("private prompt");
    expect(redacted).not.toContain("hidden");
    expect(redacted).not.toContain("result-secret");
    expect(redacted).not.toContain("supersecrettoken");
  });

  it("detects sensitive text repeatably", () => {
    expect([containsSensitiveText("Bearer supersecrettoken"), containsSensitiveText("Bearer supersecrettoken")]).toEqual([
      true,
      true,
    ]);
    expect(containsSensitiveText("ordinary preference")).toBe(false);
  });
});
