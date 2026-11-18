/**
 * npm run eval:explain -- <run dir> [--case id] [--run n]
 * npm run eval:explain -- --saturation [suite]   (default: core)
 * npm run eval:explain -- --regrade <run dir> [--suite <path>]
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { readBaselineHistory, saturatedCases, SATURATION_STREAK } from "./eval/baseline-files";
import { explainRun } from "./eval/explain";
import { formatRegrade, loadSuiteCases, regradeRun } from "./eval/regrade";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    case: { type: "string" },
    run: { type: "string" },
    saturation: { type: "boolean" },
    regrade: { type: "boolean" },
    suite: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help || (!values.saturation && positionals.length !== 1)) {
  process.stdout.write(
    "Usage:\n  npm run eval:explain -- <run dir> [--case id] [--run n]\n  npm run eval:explain -- --saturation [suite]\n  npm run eval:explain -- --regrade <run dir> [--suite <path>]\n",
  );
  process.exitCode = values.help ? 0 : 1;
} else if (values.saturation) {
  const suite = positionals[0] ?? "core";
  const history = readBaselineHistory(suite);
  const saturated = saturatedCases(history);
  process.stdout.write(
    `${suite}: ${history.length} baseline(s) in history; ${saturated.length} case(s) at pass^k in the last ${SATURATION_STREAK}:\n`,
  );
  for (const id of saturated) process.stdout.write(`- ${id}\n`);
} else if (values.regrade) {
  const runDir = path.resolve(positionals[0]);
  const plan = JSON.parse(readFileSync(path.join(runDir, "plan.json"), "utf8")) as { suite: { path: string } }; // NOSONAR:S8707 -- local dev CLI: the developer's own run directory.
  const suitePath = values.suite ?? plan.suite.path;
  process.stdout.write(formatRegrade(regradeRun(runDir, loadSuiteCases(suitePath))));
} else {
  const run = values.run === undefined ? undefined : Number(values.run);
  process.stdout.write(explainRun(path.resolve(positionals[0]), { caseId: values.case, run }));
}
