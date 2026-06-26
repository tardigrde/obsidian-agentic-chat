import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

function run(command, args, env = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: { ...process.env, ...env },
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(process.execPath, [path.join("node_modules", "typescript", "bin", "tsc"), "-noEmit"]);
run(process.execPath, ["esbuild.config.mjs", "production"], {
  AGENTIC_CHAT_ENABLE_E2E_STREAM: "1",
});
