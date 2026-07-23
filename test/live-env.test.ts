import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

interface LiveEnvModule {
  argValue(argv: string[], name: string): string | undefined;
  envValue(env: Record<string, string | undefined>, name: string, fallbackName?: string): string | undefined;
  hasAnyEnv(env: Record<string, string | undefined>, names: string[]): boolean;
  parseEnvFile(text: string): Record<string, string>;
}

async function loadLiveEnv(): Promise<LiveEnvModule> {
  return import(pathToFileURL(path.join(process.cwd(), "scripts/live-env.mjs")).href) as Promise<LiveEnvModule>;
}

describe("live script env helpers", () => {
  it("parses inline and split command arguments", async () => {
    const liveEnv = await loadLiveEnv();

    expect(liveEnv.argValue(["node", "script", "--env-file=.env"], "--env-file")).toBe(".env");
    expect(liveEnv.argValue(["node", "script", "--env-file", ".env.local"], "--env-file")).toBe(".env.local");
    expect(liveEnv.argValue(["node", "script"], "--env-file")).toBeUndefined();
  });

  it("parses dotenv-style files without overwriting shell behavior", async () => {
    const liveEnv = await loadLiveEnv();

    expect(
      liveEnv.parseEnvFile(`
        # comment
        export AGENTIC_CHAT_BASE_URL="https://openrouter.ai/api/v1"
        AGENTIC_CHAT_MODEL='openrouter/auto'
        AGENTIC_CHAT_API_KEY=secret # local comment
      `),
    ).toEqual({
      AGENTIC_CHAT_BASE_URL: "https://openrouter.ai/api/v1",
      AGENTIC_CHAT_MODEL: "openrouter/auto",
      AGENTIC_CHAT_API_KEY: "secret",
    });
  });

  it("resolves primary/fallback env values and credential presence", async () => {
    const liveEnv = await loadLiveEnv();

    expect(liveEnv.envValue({ PRIMARY: "  value  ", FALLBACK: "other" }, "PRIMARY", "FALLBACK")).toBe("value");
    expect(liveEnv.envValue({ PRIMARY: "", FALLBACK: "other" }, "PRIMARY", "FALLBACK")).toBe("other");
    expect(liveEnv.hasAnyEnv({ A: "", B: "token" }, ["A", "B"])).toBe(true);
    expect(liveEnv.hasAnyEnv({ A: "  " }, ["A", "B"])).toBe(false);
  });
});
