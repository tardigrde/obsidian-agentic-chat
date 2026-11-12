import { errorMessage } from "../../utils/errors";

export async function openAuthorizationUrl(url: string): Promise<void> {
  console.warn("Agentic Chat MCP OAuth browser opener: trying OS default browser.", url);
  if (await tryOpenWithWindowsDefaultBrowserFromWsl(url)) return;
  if (await tryOpenWithPlatformBrowser(url)) return;
  const shell = optionalElectronShell();
  if (shell) {
    try {
      console.warn("Agentic Chat MCP OAuth browser opener: trying Electron shell.openExternal.");
      await shell.openExternal(url);
      console.warn("Agentic Chat MCP OAuth browser opener: Electron shell.openExternal returned success.");
      return;
    } catch (error) {
      console.warn(
        `Agentic Chat MCP OAuth browser opener: Electron shell.openExternal failed: ${errorMessage(error)}.`,
      );
    }
  }
  console.warn("Agentic Chat MCP OAuth browser opener: trying window.open.");
  const opened = window.open(url, "_blank", "noopener,noreferrer");
  if (!opened) {
    throw new Error("Could not open the MCP OAuth authorization URL in a browser.");
  }
  console.warn("Agentic Chat MCP OAuth browser opener: window.open returned a window handle.");
}

export function optionalNodeRequire(): ((moduleName: string) => unknown) | undefined {
  const candidate = (window as unknown as { require?: (moduleName: string) => unknown }).require;
  if (typeof candidate === "function") return candidate;
  return typeof require === "function" ? require : undefined;
}

function optionalElectronShell(): ElectronShell | null {
  const requireFn = optionalNodeRequire();
  if (!requireFn) return null;
  try {
    const electron = requireFn("electron") as Partial<ElectronModule>;
    const shell = electron.shell;
    return shell && typeof shell.openExternal === "function" ? shell : null;
  } catch {
    return null;
  }
}

async function tryOpenWithWindowsDefaultBrowserFromWsl(url: string): Promise<boolean> {
  const processLike = optionalNodeProcess();
  if (
    processLike?.platform !== "linux" ||
    (!processLike.env?.WSL_DISTRO_NAME && !processLike.env?.WSL_INTEROP)
  ) {
    return false;
  }
  return (
    (await tryExecFile("rundll32.exe", ["url.dll,FileProtocolHandler", url], "WSL Windows ShellExecute")) ||
    (await tryExecFile("explorer.exe", [url], "WSL explorer.exe")) ||
    (await tryExecFile("wslview", [url], "wslview"))
  );
}

async function tryOpenWithPlatformBrowser(url: string): Promise<boolean> {
  const processLike = optionalNodeProcess();
  if (!processLike) return false;
  if (processLike.platform === "win32") {
    return (
      (await tryExecFile("rundll32.exe", ["url.dll,FileProtocolHandler", url], "Windows ShellExecute")) ||
      (await tryExecFile("explorer.exe", [url], "Windows explorer.exe")) ||
      (await tryExecFile("cmd.exe", ["/c", "start", "", url], "Windows cmd.exe start"))
    );
  }
  if (processLike.platform === "darwin") return tryExecFile("open", [url], "macOS open");
  if (processLike.platform === "linux") return tryExecFile("xdg-open", [url], "Linux xdg-open");
  return false;
}

async function tryExecFile(command: string, args: string[], label: string): Promise<boolean> {
  const requireFn = optionalNodeRequire();
  if (!requireFn) return false;
  try {
    const childProcess = requireFn("child_process") as Partial<NodeChildProcessModule>;
    if (typeof childProcess.execFile !== "function") return false;
    console.warn(`Agentic Chat MCP OAuth browser opener: trying ${label}.`);
    return await new Promise<boolean>((resolve) => {
      childProcess.execFile?.(command, args, { windowsHide: true }, (error) => {
        if (error) {
          console.warn(`Agentic Chat MCP OAuth browser opener: ${label} failed: ${errorMessage(error)}.`);
          resolve(false);
          return;
        }
        console.warn(`Agentic Chat MCP OAuth browser opener: ${label} returned success.`);
        resolve(true);
      });
    });
  } catch (error) {
    console.warn(`Agentic Chat MCP OAuth browser opener: ${label} threw: ${errorMessage(error)}.`);
    return false;
  }
}

function optionalNodeProcess(): NodeProcessLike | undefined {
  return typeof process !== "undefined" ? process : undefined;
}

interface ElectronModule {
  shell?: ElectronShell;
}

interface ElectronShell {
  openExternal(url: string): Promise<void> | void;
}

interface NodeChildProcessModule {
  execFile(
    command: string,
    args: string[],
    options: { windowsHide?: boolean },
    callback: (error: Error | null) => void,
  ): unknown;
}

interface NodeProcessLike {
  platform?: string;
  env?: Record<string, string | undefined>;
}
