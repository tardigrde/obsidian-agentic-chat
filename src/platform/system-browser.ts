import { errorMessage } from "../utils/errors";
import { optionalNodeRequire, type NodeRequire } from "./node-runtime";

/** What the opener may touch. Tests inject fakes; production uses the desktop runtime. */
export interface SystemBrowserRuntime {
  require?: NodeRequire;
  openWindow?: (url: string) => Window | null;
}

export interface OpenSystemUrlOptions {
  runtime?: SystemBrowserRuntime;
  /** Trace each attempt (the MCP OAuth flow logs them for sign-in support). */
  log?: (message: string) => void;
  /** Error message when every opener failed. */
  failureMessage?: string;
}

/**
 * Open `url` in the user's default browser, trying in order: the Windows
 * bridge from WSL, the platform opener, Electron's shell, then a browser
 * window. Every step that fails or throws falls through to the next.
 */
export async function openSystemUrl(url: string, options: OpenSystemUrlOptions = {}): Promise<void> {
  const runtime = options.runtime ?? defaultSystemBrowserRuntime();
  const log = options.log ?? (() => {});
  const requireFn = runtime.require;
  for (const [label, command, args] of platformOpeners(url, nodeProcess(requireFn))) {
    if (await tryExecFile(requireFn, command, args, label, log)) return;
  }
  const shell = electronShell(requireFn);
  if (shell) {
    try {
      log("trying Electron shell.openExternal.");
      await shell.openExternal(url);
      return;
    } catch (error) {
      log(`Electron shell.openExternal failed: ${errorMessage(error)}.`);
    }
  }
  log("trying window.open.");
  if (runtime.openWindow?.(url)) return;
  throw new Error(options.failureMessage ?? "Could not open the link in a browser.");
}

function defaultSystemBrowserRuntime(): SystemBrowserRuntime {
  return {
    require: optionalNodeRequire(),
    openWindow: (url) => (typeof window === "undefined" ? null : window.open(url, "_blank", "noopener,noreferrer")),
  };
}

type Opener = [label: string, command: string, args: string[]];

/** OS commands to try, most native first. */
export function platformOpeners(url: string, processLike: NodeProcessLike | null): Opener[] {
  if (!processLike) return [];
  const env = processLike.env ?? {};
  const shellExecute: Opener = ["Windows ShellExecute", "rundll32.exe", ["url.dll,FileProtocolHandler", url]];
  const explorer: Opener = ["Windows explorer.exe", "explorer.exe", [url]];
  switch (processLike.platform) {
    case "linux":
      if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return [shellExecute, explorer, ["wslview", "wslview", [url]]];
      return [["Linux xdg-open", "xdg-open", [url]]];
    case "win32":
      return [shellExecute, explorer, ["Windows cmd.exe start", "cmd.exe", ["/c", "start", "", url]]];
    case "darwin":
      return [["macOS open", "open", [url]]];
    default:
      return [];
  }
}

async function tryExecFile(
  requireFn: NodeRequire | undefined,
  command: string,
  args: string[],
  label: string,
  log: (message: string) => void,
): Promise<boolean> {
  if (!requireFn) return false;
  try {
    const childProcess = requireFn("child_process") as Partial<ChildProcessModule> | undefined;
    const execFile = childProcess?.execFile;
    if (typeof execFile !== "function") return false;
    log(`trying ${label}.`);
    return await new Promise<boolean>((resolve) => {
      execFile(command, args, { windowsHide: true }, (error) => {
        if (error) log(`${label} failed: ${errorMessage(error)}.`);
        resolve(!error);
      });
    });
  } catch (error) {
    log(`${label} threw: ${errorMessage(error)}.`);
    return false;
  }
}

function nodeProcess(requireFn: NodeRequire | undefined): NodeProcessLike | null {
  if (!requireFn) return null;
  try {
    const processLike = requireFn("process") as Partial<NodeProcessLike> | undefined;
    return typeof processLike?.platform === "string" ? (processLike as NodeProcessLike) : null;
  } catch {
    return null;
  }
}

function electronShell(requireFn: NodeRequire | undefined): ElectronShell | null {
  if (!requireFn) return null;
  try {
    const electron = requireFn("electron") as { shell?: Partial<ElectronShell> } | undefined;
    const shell = electron?.shell;
    return shell && typeof shell.openExternal === "function" ? (shell as ElectronShell) : null;
  } catch {
    return null;
  }
}

interface ChildProcessModule {
  execFile(
    command: string,
    args: string[],
    options: { windowsHide?: boolean },
    callback: (error: Error | null) => void,
  ): unknown;
}

export interface NodeProcessLike {
  platform: string;
  env?: Record<string, string | undefined>;
}

interface ElectronShell {
  openExternal(url: string): Promise<void> | void;
}
