import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve("src");

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "vendor") files.push(...sourceFiles(absolute));
    } else if (entry.name.endsWith(".ts")) {
      files.push(absolute);
    }
  }
  return files;
}

/** Repo-relative paths that declare `function <name>(` under `src/`, vendor excluded. */
function declarations(name: string): string[] {
  return sourceFiles(SRC)
    .filter((file) => new RegExp(`\\bfunction ${name}\\(`).test(readFileSync(file, "utf8")))
    .map((file) => path.relative(process.cwd(), file).split(path.sep).join("/"))
    .sort();
}

describe("shared helper copies", () => {
  it("keeps exactly one errorMessage declaration", () => {
    expect(declarations("errorMessage")).toEqual(["src/utils/errors.ts"]);
  });

  it("keeps exactly one shared isRecord declaration", () => {
    expect(declarations("isRecord")).toEqual(["src/retrieval/embeddings.ts", "src/utils/records.ts"]);
  });

  it("keeps exactly one shared asRecord declaration", () => {
    expect(declarations("asRecord")).toEqual(["src/secrets/legacy-plaintext.ts", "src/utils/records.ts"]);
  });

  it("exports the shared helpers", () => {
    expect(readFileSync("src/utils/errors.ts", "utf8")).toContain(
      "export function errorMessage(error: unknown): string {",
    );
    expect(readFileSync("src/utils/records.ts", "utf8")).toContain(
      "export function isRecord(value: unknown): value is Record<string, unknown> {",
    );
  });
});
