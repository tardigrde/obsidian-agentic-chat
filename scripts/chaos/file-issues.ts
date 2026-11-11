#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

/**
 * File approved chaos issue drafts: `npm run chaos:file -- logs/chaos/<run> 1 3`.
 *
 * Without numbers it only lists the drafts. A filed draft is recorded in
 * `issues/filed.json`, so a second call cannot file it twice.
 */

const LABEL = "chaos";

function gh(args: string[]): { ok: boolean; out: string } {
  const result = spawnSync("gh", args, { encoding: "utf8" });
  return { ok: result.status === 0, out: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

function main(): void {
  const args = process.argv.slice(2);
  const runDir = path.resolve(args[0] ?? "");
  const issuesDir = path.join(runDir, "issues");
  if (!existsSync(issuesDir)) {
    console.error("[chaos:file] usage: npm run chaos:file -- logs/chaos/<run> [draft numbers | --all]");
    console.error(`[chaos:file] no drafts in ${issuesDir}; run npm run chaos:mine first`);
    process.exit(1);
  }
  const drafts = readdirSync(issuesDir)
    .filter((name) => /^\d{2}-.*\.md$/.test(name))
    .sort();
  const filedPath = path.join(issuesDir, "filed.json");
  const filed = existsSync(filedPath) ? (JSON.parse(readFileSync(filedPath, "utf8")) as Record<string, string>) : {};

  const picks = args.includes("--all")
    ? drafts
    : args
        .slice(1)
        .filter((arg) => /^\d+$/.test(arg))
        .map((arg) => drafts.find((name) => Number(name.slice(0, 2)) === Number(arg)))
        .filter((name): name is string => Boolean(name));

  if (picks.length === 0) {
    for (const name of drafts) {
      const title = readFileSync(path.join(issuesDir, name), "utf8").split("\n")[0].replace(/^#\s*/, "");
      process.stdout.write(`${name.slice(0, 2)}  ${filed[name] ? `[filed ${filed[name]}] ` : ""}${title}\n`);
    }
    process.stdout.write("\nPick drafts: npm run chaos:file -- <run> 1 3   (or --all)\n");
    return;
  }

  gh(["label", "create", LABEL, "--color", "D93F0B", "--description", "Found by an exploratory chaos run"]);
  for (const name of picks) {
    if (filed[name]) {
      process.stdout.write(`[chaos:file] skip ${name}: already filed as ${filed[name]}\n`);
      continue;
    }
    const text = readFileSync(path.join(issuesDir, name), "utf8");
    const [first, ...rest] = text.split("\n");
    const title = first.replace(/^#\s*/, "").trim();
    const bodyFile = path.join(issuesDir, `.${name}.body`);
    writeFileSync(bodyFile, rest.join("\n").trimStart());
    const result = gh(["issue", "create", "--title", title, "--body-file", bodyFile, "--label", LABEL]);
    if (!result.ok) {
      console.error(`[chaos:file] failed ${name}: ${result.out}`);
      process.exitCode = 1;
      continue;
    }
    filed[name] = result.out.split("\n").at(-1) ?? "filed";
    writeFileSync(filedPath, `${JSON.stringify(filed, null, 2)}\n`);
    process.stdout.write(`[chaos:file] ${name} -> ${filed[name]}\n`);
  }
}

main();
