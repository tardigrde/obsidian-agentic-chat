import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkFeatureMap } from "../scripts/check-feature-map.mjs";

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
      "covered needs an e2e, probe, dogfood, or replay reference",
    );

    writeFileSync(
      path.join(root, "test", "replay.test.ts"),
      'import { runAgentReplay } from "./helpers/agent-replay";\n',
    );
    writeFileSync(
      path.join(features, "sample.md"),
      journey(row("src/a.ts:1", "`test/replay.test.ts:1`")),
    );
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
      "covered needs an e2e, probe, dogfood, or replay reference",
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
