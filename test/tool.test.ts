import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTool, toToolSpec, validateToolArgs } from "../src/agent/tool";

const sample = defineTool({
  name: "write_note",
  description: "Write a note",
  parameters: z.object({
    path: z.string().describe("Vault path"),
    content: z.string(),
    mode: z.enum(["create", "overwrite", "append"]).default("create"),
  }),
  execute: () => "ok",
});

describe("toToolSpec", () => {
  it("produces an OpenAI-style function spec from a zod schema", () => {
    const spec = toToolSpec(sample);

    expect(spec.type).toBe("function");
    expect(spec.function.name).toBe("write_note");
    expect(spec.function.description).toBe("Write a note");

    const params = spec.function.parameters as {
      type: string;
      properties: Record<string, { type?: string; enum?: string[]; description?: string }>;
      required?: string[];
    };
    expect(params.type).toBe("object");
    expect(params.properties.path.type).toBe("string");
    expect(params.properties.path.description).toBe("Vault path");
    expect(params.properties.mode.enum).toEqual(["create", "overwrite", "append"]);
    expect(params.required).toContain("path");
    expect(params.required).toContain("content");
    expect(params.required ?? []).not.toContain("mode");
    expect(spec.function.parameters).not.toHaveProperty("$schema");
  });
});

describe("validateToolArgs", () => {
  const schema = sample.parameters;

  it("accepts valid arguments and applies defaults", () => {
    const result = validateToolArgs(schema, '{"path":"a.md","content":"x"}');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.args).toEqual({ path: "a.md", content: "x", mode: "create" });
    }
  });

  it("rejects malformed JSON with a readable message", () => {
    const result = validateToolArgs(schema, "{not json");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Invalid JSON");
  });

  it("rejects schema violations and names the offending field", () => {
    const result = validateToolArgs(schema, '{"path":5,"content":"x"}');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Invalid arguments");
      expect(result.error).toContain("path");
    }
  });

  it("treats an empty argument string as an empty object", () => {
    const result = validateToolArgs(z.object({}), "");

    expect(result.ok).toBe(true);
  });
});
