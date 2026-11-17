import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planPrune } from "../scripts/logs-prune.mjs";

const DAY = 24 * 60 * 60 * 1000;

describe("logs:prune", () => {
  let root: string;
  const now = Date.UTC(2026, 10, 16);
  const touch = (relative: string, ageDays: number, body = "x") => {
    const full = path.join(root, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body);
    const time = new Date(now - ageDays * DAY);
    utimesSync(full, time, time);
    utimesSync(path.dirname(full), time, time);
  };

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "logs-prune-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("keeps exactly the configured newest runs and ages out media", () => {
    for (let index = 0; index < 5; index += 1) touch(`logs/verify/run-${index}/summary.json`, index);
    touch("logs/chaos/old/session.mp4", 40);
    touch("logs/chaos/new/session.mp4", 2);
    touch("logs/design-audit/a.png", 1);
    touch("logs/history.jsonl", 400);
    touch("src/keep.ts", 400);

    const plan = planPrune(root, {
      now,
      rules: [
        { dir: "verify", keepNewest: 3 },
        { dir: "chaos", maxAgeDays: 30 },
        { dir: "design-audit", removeAll: true },
      ],
    });
    const removed = plan.map((entry) => path.relative(root, entry.path)).sort();
    expect(removed).toEqual(["logs/chaos/old", "logs/design-audit", "logs/verify/run-3", "logs/verify/run-4"]);
  });

  it("never plans a path outside logs/ or the history file", () => {
    touch("logs/stale/main.js", 1);
    touch("logs/history.jsonl", 1);
    const plan = planPrune(root, { now, rules: [{ dir: "..", removeAll: true }] });
    const removed = plan.map((entry) => path.relative(root, entry.path));
    expect(removed).toEqual(["logs/stale/main.js"]);
  });

  it("does nothing without a logs/ directory", () => {
    expect(planPrune(root, { now })).toEqual([]);
  });
});
