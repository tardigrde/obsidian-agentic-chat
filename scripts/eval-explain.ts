/**
 * npm run eval:explain -- <run dir> [--case id] [--run n]
 * npm run eval:explain -- --saturation [suite]   (default: core)
 */

import * as path from "node:path";
import { parseArgs } from "node:util";
import { readBaselineHistory, saturatedCases, SATURATION_STREAK } from "./eval/baseline-files";
import { explainRun } from "./eval/explain";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    case: { type: "string" },
    run: { type: "string" },
    saturation: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help || (!values.saturation && positionals.length !== 1)) {
  process.stdout.write(
    "Usage:\n  npm run eval:explain -- <run dir> [--case id] [--run n]\n  npm run eval:explain -- --saturation [suite]\n",
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
} else {
  const run = values.run === undefined ? undefined : Number(values.run);
  process.stdout.write(explainRun(path.resolve(positionals[0]), { caseId: values.case, run }));
}
