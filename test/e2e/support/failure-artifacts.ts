import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { browser } from "@wdio/globals";
import { redactJsonl, redactValue } from "../../../src/privacy/redaction";

interface TestLike {
  title?: string;
  fullTitle?: string;
  fullName?: string;
  file?: string;
}

interface TestResultLike {
  error?: unknown;
  passed: boolean;
  duration: number;
  retries?: unknown;
  status?: string;
}

interface FailureArtifactOptions {
  test: TestLike;
  result: TestResultLike;
  artifactsRoot: string;
}

interface ObsidianDiagnostics {
  uiText: string;
  vault: {
    configDir: string;
    adapterName: string;
  };
  plugin: {
    present: boolean;
    settings?: unknown;
  };
  latestSession?: {
    path: string;
    modifiedTime?: number;
    content: string;
  };
}

export async function collectE2EFailureArtifacts({ test, result, artifactsRoot }: FailureArtifactOptions): Promise<void> {
  if (result.passed) return;

  const dir = path.join(artifactsRoot, `${timestamp()}-${slug(test.fullTitle || test.fullName || test.title || "test")}`);
  await mkdir(dir, { recursive: true });

  await writeJson(path.join(dir, "wdio-result.json"), {
    test: {
      title: test.title,
      fullTitle: test.fullTitle,
      fullName: test.fullName,
      file: test.file,
    },
    result: {
      status: result.status,
      duration: result.duration,
      retries: result.retries,
      error: serializeError(result.error),
    },
  });

  await collectScreenshot(dir);
  await collectBrowserConsole(dir);
  await collectObsidianDiagnostics(dir);

  console.warn(`Agentic chat e2e artifacts: ${dir}`);
}

async function collectScreenshot(dir: string): Promise<void> {
  try {
    await browser.saveScreenshot(path.join(dir, "screenshot.png"));
  } catch (error) {
    await writeText(path.join(dir, "screenshot-error.txt"), errorMessage(error));
  }
}

async function collectBrowserConsole(dir: string): Promise<void> {
  try {
    const logs = await (browser as unknown as { getLogs?: (type: string) => Promise<unknown[]> }).getLogs?.("browser");
    await writeJson(path.join(dir, "browser-console.json"), logs ?? []);
  } catch (error) {
    await writeText(path.join(dir, "browser-console-error.txt"), errorMessage(error));
  }
}

async function collectObsidianDiagnostics(dir: string): Promise<void> {
  try {
    const diagnostics = await browser.executeObsidian(async ({ app }) => {
      const plugin = (app as unknown as { plugins?: { plugins?: Record<string, unknown> } }).plugins?.plugins?.[
        "agentic-chat"
      ] as { settings?: unknown; manifest?: { dir?: string } } | undefined;
      const adapter = app.vault.adapter;
      const pluginDir = plugin?.manifest?.dir ?? `${app.vault.configDir}/plugins/agentic-chat`;
      const sessionsDir = `${pluginDir}/sessions`;
      const sessions = (await adapter.exists(sessionsDir))
        ? await Promise.all(
            (await adapter.list(sessionsDir)).files
              .filter((file) => file.endsWith(".jsonl"))
              .map(async (file) => ({ path: file, stat: await adapter.stat(file) })),
          )
        : [];
      sessions.sort((a, b) => (b.stat?.mtime ?? 0) - (a.stat?.mtime ?? 0) || b.path.localeCompare(a.path));
      const latest = sessions[0];

      return {
        uiText: document.querySelector(".agentic-chat-view")?.textContent ?? "",
        vault: {
          configDir: app.vault.configDir,
          adapterName: adapter.getName(),
        },
        plugin: {
          present: !!plugin,
          settings: plugin?.settings,
        },
        latestSession: latest
          ? {
              path: latest.path,
              modifiedTime: latest.stat?.mtime,
              content: await adapter.read(latest.path),
            }
          : undefined,
      } satisfies ObsidianDiagnostics;
    });

    await writeText(path.join(dir, "obsidian-ui.txt"), diagnostics.uiText);
    await writeJson(path.join(dir, "obsidian-vault.json"), diagnostics.vault);
    await writeJson(path.join(dir, "settings.redacted.json"), redactSecrets(diagnostics.plugin.settings ?? {}));
    if (diagnostics.latestSession) {
      await writeJson(path.join(dir, "latest-session-meta.json"), {
        path: diagnostics.latestSession.path,
        modifiedTime: diagnostics.latestSession.modifiedTime,
      });
      await writeText(
        path.join(dir, "latest-session.redacted.jsonl"),
        redactJsonl(diagnostics.latestSession.content, {
          maxLength: 500,
          maxArrayLength: 20,
          maxObjectKeys: 30,
          maxDepth: 6,
          summarizeContent: true,
          redactHighEntropy: true,
        }),
      );
    } else {
      await writeText(path.join(dir, "latest-session-missing.txt"), "No agentic-chat session JSONL was present.\n");
    }
  } catch (error) {
    await writeText(path.join(dir, "obsidian-diagnostics-error.txt"), errorMessage(error));
  }
}

function redactSecrets(value: unknown): unknown {
  return redactValue(value, {
    maxLength: 500,
    maxArrayLength: 20,
    maxObjectKeys: 60,
    maxDepth: 8,
    summarizeContent: true,
    redactHighEntropy: true,
  });
}

function serializeError(error: unknown): unknown {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return error;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function slug(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized.slice(0, 80) || "test";
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeText(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeText(file: string, value: string): Promise<void> {
  await writeFile(file, value, "utf8");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error);
}
