import process from "node:process";
import { generateDogfoodVault, writeManifest } from "./dogfood-core";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const vaultPath = requiredArg(args, "vault");
  const externalRoot = requiredArg(args, "external-root");
  const manifest = await generateDogfoodVault({
    vaultPath,
    externalRoot,
    runId: args["run-id"],
    secretText: args.secret,
  });
  const manifestPath = await writeManifest(manifest);
  process.stdout.write(`${JSON.stringify({ manifestPath, manifest }, null, 2)}\n`);
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
