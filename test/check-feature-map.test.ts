import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkFeatureMap, fixFeatureMap, writeLock } from "../scripts/check-feature-map.mjs";

const FEATURES = path.join(".agents", "skills", "verify-obsidian-chat", "features");

function row(
  source = "src/a.ts:1",
  proof = "`test/e2e/sample.e2e.ts:1`",
  status = "covered",
  entry = "Do a thing",
) {
  return `| ${entry} | \`${source}\` | ${proof} | \`${status}\` |`;
}

function journey(proofRow = row(), section = "## Gotchas") {
  return [
    "# Sample",
    "",
    "## Sub-features",
    "",
    "- one",
    "",
    "## How to get to it (user view)",
    "",
    "- one",
    "",
    "## Driving it with the probe harness",
    "",
    "- one",
    "",
    "## Proof",
    "",
    "| entry point | source | proof | status |",
    "|---|---|---|---|",
    proofRow,
    "",
    section,
    "",
    "- none",
    "",
  ].join("\n");
}

describe("check-feature-map", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "feature-map-"));
    const features = path.join(root, FEATURES);
    mkdirSync(features, { recursive: true });
    mkdirSync(path.join(root, "src"), { recursive: true });
    mkdirSync(path.join(root, "test", "e2e"), { recursive: true });
    writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(path.join(root, "test", "a.test.ts"), "export {};\n");
    writeFileSync(path.join(root, "test", "e2e", "sample.e2e.ts"), "export {};\n");
    writeFileSync(
      path.join(features, "README.md"),
      "# Feature map\n\n| Journey | Covers |\n|---|---|\n| [Sample](./sample.md) | one |\n",
    );
    writeFileSync(path.join(features, "sample.md"), journey());
    writeLock(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("accepts the committed map", () => {
    const result = checkFeatureMap(process.cwd());
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.journeys).toBeGreaterThan(0);
    expect(result.rows).toBeGreaterThan(0);
    expect(result.refs).toBeGreaterThan(0);
  });

  it("accepts a valid fixture and counts rows and refs", () => {
    expect(checkFeatureMap(root)).toMatchObject({
      ok: true,
      errors: [],
      journeys: 1,
      rows: 1,
      refs: 2,
    });
  });

  it("rejects a blank or missing source line", () => {
    const features = path.join(root, FEATURES);
    writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1;\n\n");
    writeFileSync(path.join(features, "sample.md"), journey(row("src/a.ts:2")));
    expect(checkFeatureMap(root).errors.join("\n")).toContain("points at a blank line");
    writeFileSync(path.join(features, "sample.md"), journey(row("src/missing.ts:1")));
    expect(checkFeatureMap(root).errors.join("\n")).toContain("missing file");
    writeFileSync(path.join(features, "sample.md"), journey(row("src/a.ts:99")));
    expect(checkFeatureMap(root).errors.join("\n")).toContain("outside the file");
  });

  it("fails when the text at a locked ref changes", () => {
    writeFileSync(path.join(root, "src", "a.ts"), "export const a = 2;\n");
    const errors = checkFeatureMap(root).errors.join("\n");
    expect(errors).toContain("src/a.ts:1");
    expect(errors).toContain('expected "export const a = 1;"');
    expect(errors).toContain('found "export const a = 2;"');
  });

  it("fails when a ref has no lock entry", () => {
    const features = path.join(root, FEATURES);
    writeFileSync(path.join(root, "src", "b.ts"), "export const b = 1;\n");
    writeFileSync(path.join(features, "sample.md"), journey(row("src/b.ts:1")));
    expect(checkFeatureMap(root).errors.join("\n")).toContain("has no lock entry");
  });

  it("fix moves a ref to the same text lower in the same file", () => {
    writeFileSync(path.join(root, "src", "a.ts"), "// one\n// two\n// three\nexport const a = 1;\n");
    const result = fixFeatureMap(root);
    expect(result.moved).toEqual([{ from: "src/a.ts:1", to: "src/a.ts:4" }]);
    expect(result.unplaced).toEqual([]);
    expect(readFileSync(path.join(root, FEATURES, "sample.md"), "utf8")).toContain("`src/a.ts:4`");
    expect(checkFeatureMap(root).errors).toEqual([]);
  });

  it("fix moves a ref to a unique match in another source file", () => {
    writeFileSync(path.join(root, "src", "a.ts"), "export const a = 2;\n");
    writeFileSync(path.join(root, "src", "b.ts"), "// shifted\nexport const a = 1;\n");
    const result = fixFeatureMap(root);
    expect(result.moved).toEqual([{ from: "src/a.ts:1", to: "src/b.ts:2" }]);
    expect(result.unplaced).toEqual([]);
    expect(checkFeatureMap(root).errors).toEqual([]);
  });

  it("fix leaves a ref whose text still matches and reports an unplaceable ref", () => {
    expect(fixFeatureMap(root).moved).toEqual([]);

    writeFileSync(path.join(root, "src", "a.ts"), "export const a = 2;\n");
    writeFileSync(path.join(root, "src", "b.ts"), "export const a = 1;\n");
    writeFileSync(path.join(root, "src", "c.ts"), "export const a = 1;\n");
    const result = fixFeatureMap(root);
    expect(result.moved).toEqual([]);
    expect(result.unplaced.map((entry) => entry.ref)).toEqual(["src/a.ts:1"]);
    expect(checkFeatureMap(root).ok).toBe(false);
  });

  it("fails when a known command id has no map row, and passes once the row is added", () => {
    writeFileSync(
      path.join(root, "src", "main.ts"),
      [
        "export class Plugin {",
        "  onload() {",
        "    this.addCommand({",
        '      id: "open-chat",',
        '      name: "Open chat",',
        "    });",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    expect(checkFeatureMap(root).errors.join("\n")).toContain("open-chat");

    const features = path.join(root, FEATURES);
    const extra = "| Command palette: Open chat | `src/main.ts:4` | no committed check | `NONE` |";
    writeFileSync(path.join(features, "sample.md"), journey(`${row()}\n${extra}`));
    writeLock(root);
    expect(checkFeatureMap(root)).toMatchObject({ ok: true, errors: [] });
  });

  it("rejects covered without a test reference or with partial wording", () => {
    const features = path.join(root, FEATURES);
    writeFileSync(path.join(features, "sample.md"), journey(row("src/a.ts:1", "no committed check")));
    expect(checkFeatureMap(root).errors.join("\n")).toContain("covered needs a committed test reference");
    writeFileSync(
      path.join(features, "sample.md"),
      journey(row("src/a.ts:1", "`test/e2e/sample.e2e.ts:1` (unit only)")),
    );
    expect(checkFeatureMap(root).errors.join("\n")).toContain('covered proof says "unit only"');
  });

  it("rejects unit-only proof for covered but accepts replay proof", () => {
    const features = path.join(root, FEATURES);
    writeFileSync(path.join(features, "sample.md"), journey(row("src/a.ts:1", "`test/a.test.ts:1`")));
    expect(checkFeatureMap(root).errors.join("\n")).toContain(
      "covered needs a deterministic e2e, probe, or replay reference",
    );

    writeFileSync(
      path.join(root, "test", "replay.test.ts"),
      'import { runAgentReplay } from "./helpers/agent-replay";\n',
    );
    writeFileSync(
      path.join(features, "sample.md"),
      journey(row("src/a.ts:1", "`test/replay.test.ts:1`")),
    );
    writeLock(root);
    expect(checkFeatureMap(root)).toMatchObject({ ok: true, errors: [] });
  });

  it("rejects a non-test file as covered proof", () => {
    const features = path.join(root, FEATURES);
    writeFileSync(path.join(root, "test", "data.json"), "{}\n");
    writeFileSync(
      path.join(features, "sample.md"),
      journey(row("src/a.ts:1", "`test/data.json:1`")),
    );
    expect(checkFeatureMap(root).errors.join("\n")).toContain(
      "covered needs a deterministic e2e, probe, or replay reference",
    );
  });

  it("rejects live specs, dogfood specs, and comment-only replay mentions", () => {
    const features = path.join(root, FEATURES);
    writeFileSync(path.join(root, "test", "e2e", "mcp-live.e2e.ts"), "export {};\n");
    writeFileSync(
      path.join(features, "sample.md"),
      journey(row("src/a.ts:1", "`test/e2e/mcp-live.e2e.ts:1`")),
    );
    expect(checkFeatureMap(root).errors.join("\n")).toContain(
      "covered needs a deterministic e2e, probe, or replay reference",
    );

    mkdirSync(path.join(root, "test", "e2e", "dogfood"), { recursive: true });
    writeFileSync(path.join(root, "test", "e2e", "dogfood", "flow.dogfood.ts"), "export {};\n");
    writeFileSync(
      path.join(features, "sample.md"),
      journey(row("src/a.ts:1", "`test/e2e/dogfood/flow.dogfood.ts:1`")),
    );
    expect(checkFeatureMap(root).errors.join("\n")).toContain(
      "covered needs a deterministic e2e, probe, or replay reference",
    );

    writeFileSync(
      path.join(root, "test", "fake-replay.test.ts"),
      '// import { runAgentReplay } from "./helpers/agent-replay";\n',
    );
    writeFileSync(
      path.join(features, "sample.md"),
      journey(row("src/a.ts:1", "`test/fake-replay.test.ts:1`")),
    );
    expect(checkFeatureMap(root).errors.join("\n")).toContain(
      "covered needs a deterministic e2e, probe, or replay reference",
    );

    writeFileSync(
      path.join(root, "test", "fake-replay.test.ts"),
      'import type { runAgentReplay } from "./helpers/agent-replay";\n',
    );
    writeFileSync(
      path.join(features, "sample.md"),
      journey(row("src/a.ts:1", "`test/fake-replay.test.ts:1`")),
    );
    expect(checkFeatureMap(root).errors.join("\n")).toContain(
      "covered needs a deterministic e2e, probe, or replay reference",
    );
  });

  it("rejects an unknown status and NONE with a proof reference", () => {
    const features = path.join(root, FEATURES);
    writeFileSync(path.join(features, "sample.md"), journey(row("src/a.ts:1", "`test/a.test.ts:1`", "done")));
    expect(checkFeatureMap(root).errors.join("\n")).toContain('unknown status "done"');
    writeFileSync(path.join(features, "sample.md"), journey(row("src/a.ts:1", "`test/a.test.ts:1`", "NONE")));
    expect(checkFeatureMap(root).errors.join("\n")).toContain("NONE must not cite a proof reference");
  });

  it("allows a source reference as unreachable proof", () => {
    const features = path.join(root, FEATURES);
    writeFileSync(
      path.join(features, "sample.md"),
      journey(row("src/a.ts:1", "no production caller, filter at `src/a.ts:1`", "unreachable")),
    );
    expect(checkFeatureMap(root)).toMatchObject({ ok: true, errors: [] });
  });

  it("rejects a missing section and an unlinked journey", () => {
    const features = path.join(root, FEATURES);
    writeFileSync(path.join(features, "sample.md"), journey(undefined, "## Other"));
    expect(checkFeatureMap(root).errors.join("\n")).toContain('missing section "## Gotchas"');
    writeFileSync(
      path.join(features, "README.md"),
      "# Feature map\n\n| [Other](./other.md) | two |\n",
    );
    expect(checkFeatureMap(root).errors.join("\n")).toContain('journey "sample.md" is not linked');
    expect(checkFeatureMap(root).errors.join("\n")).toContain("link target is missing");
  });
});
