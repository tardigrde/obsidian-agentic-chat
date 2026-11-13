import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const FEATURES = path.join(".agents", "skills", "verify-obsidian-chat", "features");
const SCRIPT = fileURLToPath(new URL("../scripts/check-feature-map.mjs", import.meta.url));

function row(
  source = "src/a.ts#alpha",
  proof = "`test/e2e/sample.e2e.ts#sample flow`",
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

function run(cwd: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return { status: result.status, stdout, stderr, output: `${stdout}${stderr}` };
}

describe("check-feature-map", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "feature-map-"));
    const features = path.join(root, FEATURES);
    mkdirSync(features, { recursive: true });
    mkdirSync(path.join(root, "src"), { recursive: true });
    mkdirSync(path.join(root, "test", "e2e"), { recursive: true });
    writeFileSync(path.join(root, "src", "a.ts"), "export const alpha = 1;\n");
    writeFileSync(path.join(root, "test", "a.test.ts"), 'it("unit case", () => {});\n');
    writeFileSync(path.join(root, "test", "e2e", "sample.e2e.ts"), 'it("sample flow", () => {});\n');
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
    const result = run(process.cwd());
    expect(result.status).toBe(0);
    expect(result.output).toContain("feature map: PASS");
    expect(result.output).toMatch(/\(\d+ journeys, \d+ rows, \d+ refs\)/);
  });

  it("accepts a valid fixture and counts rows and refs", () => {
    const result = run(root);
    expect(result.status).toBe(0);
    expect(result.output).toContain("feature map: PASS (1 journeys, 1 rows, 2 refs)");
  });

  it("rejects a missing file and an anchor that is no longer in the file", () => {
    const features = path.join(root, FEATURES);
    writeFileSync(path.join(features, "sample.md"), journey(row("src/missing.ts#alpha")));
    expect(run(root).output).toContain("missing file");
    writeFileSync(path.join(features, "sample.md"), journey(row("src/a.ts#beta")));
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain('anchor "beta" is not in src/a.ts');
  });

  it("keeps passing when the anchored code moves inside its file", () => {
    writeFileSync(path.join(root, "src", "a.ts"), "// one\n// two\n// three\nexport const alpha = 1;\n");
    expect(run(root).status).toBe(0);
  });

  it("fails when the anchored code moves to another file", () => {
    writeFileSync(path.join(root, "src", "a.ts"), "export {};\n");
    writeFileSync(path.join(root, "src", "b.ts"), "export const alpha = 1;\n");
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain('anchor "alpha" is not in src/a.ts');
  });

  it("rejects an old path:line ref", () => {
    const features = path.join(root, FEATURES);
    writeFileSync(path.join(features, "sample.md"), journey(row("src/a.ts:1")));
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain("uses a line number");
  });

  it("matches settings rows by entry name and scans every settings file", () => {
    const features = path.join(root, FEATURES);
    writeFileSync(
      path.join(root, "src", "settings-extra.ts"),
      [
        'import { row } from "./settings-definition-kit";',
        'const name = row("Name", () => {});',
        'const load = row("Import", () => {});',
        'const header = row("Auth header", () => {});',
        "",
      ].join("\n"),
    );
    mkdirSync(path.join(root, "src", "settings"), { recursive: true });
    writeFileSync(
      path.join(root, "src", "settings", "nested.ts"),
      [
        'import { controlDef, row } from "../settings-definition-kit";',
        'const nested = row("Nested control", () => {});',
        "",
      ].join("\n"),
    );
    writeFileSync(
      path.join(features, "sample.md"),
      journey(
        [
          row(),
          "| `/agent <name> <task>` | `src/a.ts#alpha` | `test/e2e/sample.e2e.ts#sample flow` | `covered` |",
          "| Imported MCP servers start disabled | `src/a.ts#alpha` | `test/e2e/sample.e2e.ts#sample flow` | `covered` |",
          "| Observability: generic OTLP auth header | `src/a.ts#alpha` | `test/e2e/sample.e2e.ts#sample flow` | `covered` |",
        ].join("\n"),
      ),
    );
    const before = run(root).output;
    expect(before).toContain('settings row "Name" is not named');
    expect(before).toContain('settings row "Import" is not named');
    expect(before).toContain('settings row "Auth header" is not named');
    expect(before).toContain('settings row "Nested control" is not named');

    writeFileSync(
      path.join(features, "sample.md"),
      journey(
        [
          row(),
          "| MCP server: Name | `src/settings-extra.ts#Name` | `test/e2e/sample.e2e.ts#sample flow` | `covered` |",
          "| Agent plugins: Import | `src/settings-extra.ts#Import` | `test/e2e/sample.e2e.ts#sample flow` | `covered` |",
          "| MCP server: Auth header | `src/settings-extra.ts#Auth header` | `test/e2e/sample.e2e.ts#sample flow` | `covered` |",
          "| Settings: Nested control | `src/settings/nested.ts#Nested control` | `test/e2e/sample.e2e.ts#sample flow` | `covered` |",
        ].join("\n"),
      ),
    );
    expect(run(root).status).toBe(0);
  });

  it("does not count a row whose first cell only starts with the settings row name", () => {
    const features = path.join(root, FEATURES);
    writeFileSync(
      path.join(root, "src", "settings-models.ts"),
      'import { row } from "./settings-definition-kit";\nconst model = row("Model", () => {});\n',
    );
    const unrelated = "| Model calls the `subagent` tool | `src/a.ts#alpha` | `test/e2e/sample.e2e.ts#sample flow` | `covered` |";
    writeFileSync(path.join(features, "sample.md"), journey(`${row()}\n${unrelated}`));
    expect(run(root).output).toContain('settings row "Model" is not named');
    const own = "| Models: provider, model | `src/settings-models.ts#row(\"Model\"` | `test/e2e/sample.e2e.ts#sample flow` | `covered` |";
    writeFileSync(path.join(features, "sample.md"), journey(`${row()}\n${unrelated}\n${own}`));
    expect(run(root).status).toBe(0);
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
    expect(run(root).output).toContain("open-chat");

    const features = path.join(root, FEATURES);
    const extra = "| Command palette: Open chat | `src/main.ts#open-chat` | no committed check | `NONE` |";
    writeFileSync(path.join(features, "sample.md"), journey(`${row()}\n${extra}`));
    expect(run(root).status).toBe(0);
  });

  it("rejects covered without a test reference or with partial wording", () => {
    const features = path.join(root, FEATURES);
    writeFileSync(path.join(features, "sample.md"), journey(row("src/a.ts#alpha", "no committed check")));
    expect(run(root).output).toContain("covered needs a committed test reference");
    writeFileSync(
      path.join(features, "sample.md"),
      journey(row("src/a.ts#alpha", "`test/e2e/sample.e2e.ts#sample flow` (unit only)")),
    );
    expect(run(root).output).toContain('covered proof says "unit only"');
  });

  it("rejects unit-only proof for covered but accepts replay proof", () => {
    const features = path.join(root, FEATURES);
    writeFileSync(path.join(features, "sample.md"), journey(row("src/a.ts#alpha", "`test/a.test.ts#unit case`")));
    expect(run(root).output).toContain(
      "covered needs a deterministic e2e, probe, or replay reference",
    );

    writeFileSync(
      path.join(root, "test", "replay.test.ts"),
      'import { runAgentReplay } from "./helpers/agent-replay";\n',
    );
    writeFileSync(
      path.join(features, "sample.md"),
      journey(row("src/a.ts#alpha", "`test/replay.test.ts#runAgentReplay`")),
    );
    expect(run(root).status).toBe(0);
  });

  it("rejects a non-test file as covered proof", () => {
    const features = path.join(root, FEATURES);
    writeFileSync(path.join(root, "test", "data.json"), "{}\n");
    writeFileSync(
      path.join(features, "sample.md"),
      journey(row("src/a.ts#alpha", "`test/data.json#{}`")),
    );
    expect(run(root).output).toContain(
      "covered needs a deterministic e2e, probe, or replay reference",
    );
  });

  it("rejects live specs, dogfood specs, and comment-only replay mentions", () => {
    const features = path.join(root, FEATURES);
    writeFileSync(path.join(root, "test", "e2e", "mcp-live.e2e.ts"), "export {};\n");
    writeFileSync(
      path.join(features, "sample.md"),
      journey(row("src/a.ts#alpha", "`test/e2e/mcp-live.e2e.ts#export`")),
    );
    expect(run(root).output).toContain(
      "covered needs a deterministic e2e, probe, or replay reference",
    );

    mkdirSync(path.join(root, "test", "e2e", "dogfood"), { recursive: true });
    writeFileSync(path.join(root, "test", "e2e", "dogfood", "flow.dogfood.ts"), "export {};\n");
    writeFileSync(
      path.join(features, "sample.md"),
      journey(row("src/a.ts#alpha", "`test/e2e/dogfood/flow.dogfood.ts#export`")),
    );
    expect(run(root).output).toContain(
      "covered needs a deterministic e2e, probe, or replay reference",
    );

    writeFileSync(
      path.join(root, "test", "fake-replay.test.ts"),
      '// import { runAgentReplay } from "./helpers/agent-replay";\n',
    );
    writeFileSync(
      path.join(features, "sample.md"),
      journey(row("src/a.ts#alpha", "`test/fake-replay.test.ts#runAgentReplay`")),
    );
    expect(run(root).output).toContain(
      "covered needs a deterministic e2e, probe, or replay reference",
    );

    writeFileSync(
      path.join(root, "test", "fake-replay.test.ts"),
      'import type { runAgentReplay } from "./helpers/agent-replay";\n',
    );
    writeFileSync(
      path.join(features, "sample.md"),
      journey(row("src/a.ts#alpha", "`test/fake-replay.test.ts#runAgentReplay`")),
    );
    expect(run(root).output).toContain(
      "covered needs a deterministic e2e, probe, or replay reference",
    );
  });

  it("rejects an unknown status and NONE with a proof reference", () => {
    const features = path.join(root, FEATURES);
    writeFileSync(path.join(features, "sample.md"), journey(row("src/a.ts#alpha", "`test/a.test.ts#unit case`", "done")));
    expect(run(root).output).toContain('unknown status "done"');
    writeFileSync(path.join(features, "sample.md"), journey(row("src/a.ts#alpha", "`test/a.test.ts#unit case`", "NONE")));
    expect(run(root).output).toContain("NONE must not cite a proof reference");
  });

  it("allows a source reference as unreachable proof", () => {
    const features = path.join(root, FEATURES);
    writeFileSync(
      path.join(features, "sample.md"),
      journey(row("src/a.ts#alpha", "no production caller, filter at `src/a.ts#alpha`", "unreachable")),
    );
    expect(run(root).status).toBe(0);
  });

  it("rejects a missing section and an unlinked journey", () => {
    const features = path.join(root, FEATURES);
    writeFileSync(path.join(features, "sample.md"), journey(undefined, "## Other"));
    expect(run(root).output).toContain('missing section "## Gotchas"');
    writeFileSync(
      path.join(features, "README.md"),
      "# Feature map\n\n| [Other](./other.md) | two |\n",
    );
    expect(run(root).output).toContain('journey "sample.md" is not linked');
    expect(run(root).output).toContain("link target is missing");
  });
});
