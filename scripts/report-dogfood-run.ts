import process from "node:process";
import { assertDogfoodInvariants, writeDogfoodRunReport } from "./dogfood-core";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = requiredArg(args, "manifest");
  const result = await assertDogfoodInvariants(manifestPath);
  const reportPath = await writeDogfoodRunReport(result, args.out ?? "logs/dogfood-runs");
  process.stdout.write(`${JSON.stringify({ reportPath, ok: result.ok, findings: result.findings }, null, 2)}\n`);
  if (!result.ok) process.exit(1);
}

function parseArgs(argv: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (!raw.startsWith("--")) throw new Error(`Unexpected argument: ${raw}`);
    const key = raw.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    parsed[key] = value;
    index += 1;
  }
  return parsed;
}

function requiredArg(args: Record<string, string>, name: string): string {
  const value = args[name];
  if (!value) throw new Error(`Missing required --${name}`);
  return value;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
