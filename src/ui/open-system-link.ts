export interface SystemLinkRuntime {
  require?: (moduleName: string) => unknown;
  openWindow?: (url: string) => Window | null;
}

export async function openSystemUrl(url: string, runtime: SystemLinkRuntime = defaultSystemLinkRuntime()): Promise<void> {
  if (await tryOpenWithWindowsDefaultBrowserFromWsl(url, runtime)) return;
  if (await tryOpenWithPlatformBrowser(url, runtime)) return;
  const shell = optionalElectronShell(runtime);
  if (shell?.openExternal) {
    await shell.openExternal(url);
    return;
  }
  const opened = runtime.openWindow?.(url);
  if (!opened) throw new Error("Could not open the link in a browser.");
}

function defaultSystemLinkRuntime(): SystemLinkRuntime {
  const win = window as { require?: (moduleName: string) => unknown; open?: Window["open"] };
  return {
    require: typeof win.require === "function" ? win.require : undefined,
    openWindow: (url) => win.open?.(url, "_blank", "noopener,noreferrer") ?? null,
  };
}

async function tryOpenWithWindowsDefaultBrowserFromWsl(url: string, runtime: SystemLinkRuntime): Promise<boolean> {
  const processLike = optionalNodeProcess(runtime);
  if (
    processLike?.platform !== "linux" ||
    (!processLike.env?.WSL_DISTRO_NAME && !processLike.env?.WSL_INTEROP)
  ) {
    return false;
  }
  return (
    (await tryExecFile(runtime, "rundll32.exe", ["url.dll,FileProtocolHandler", url])) ||
    (await tryExecFile(runtime, "explorer.exe", [url])) ||
    (await tryExecFile(runtime, "wslview", [url]))
  );
}

async function tryOpenWithPlatformBrowser(url: string, runtime: SystemLinkRuntime): Promise<boolean> {
  const processLike = optionalNodeProcess(runtime);
  if (!processLike) return false;
  if (processLike.platform === "win32") return tryExecFile(runtime, "cmd.exe", ["/c", "start", "", url]);
  if (processLike.platform === "darwin") return tryExecFile(runtime, "open", [url]);
  if (processLike.platform === "linux") return tryExecFile(runtime, "xdg-open", [url]);
  return false;
}

async function tryExecFile(runtime: SystemLinkRuntime, command: string, args: string[]): Promise<boolean> {
  const execFile = optionalExecFile(runtime);
  if (!execFile) return false;
  return await new Promise<boolean>((resolve) => {
    try {
      execFile(command, args, { windowsHide: true }, (error) => resolve(!error));
    } catch {
      resolve(false);
    }
  });
}

function optionalExecFile(runtime: SystemLinkRuntime): ExecFile | null {
  try {
    const childProcess = runtime.require?.("child_process") as Partial<ChildProcessModule> | undefined;
    return typeof childProcess?.execFile === "function" ? childProcess.execFile : null;
  } catch {
    return null;
  }
}

function optionalNodeProcess(runtime: SystemLinkRuntime): NodeProcessLike | null {
  try {
    const processLike = runtime.require?.("process") as Partial<NodeProcessLike> | undefined;
    return typeof processLike?.platform === "string" ? (processLike as NodeProcessLike) : null;
  } catch {
    return null;
  }
}

function optionalElectronShell(runtime: SystemLinkRuntime): ElectronShell | null {
  try {
    const electron = runtime.require?.("electron") as Partial<ElectronModule> | undefined;
    const shell = electron?.shell;
    return shell && typeof shell.openExternal === "function" ? shell : null;
  } catch {
    return null;
  }
}

type ExecFile = (
  command: string,
  args: string[],
  options: { windowsHide?: boolean },
  callback: (error: Error | null) => void,
) => void;

interface ChildProcessModule {
  execFile: ExecFile;
}

interface NodeProcessLike {
  platform: string;
  env?: Record<string, string | undefined>;
}

interface ElectronModule {
  shell?: ElectronShell;
}

interface ElectronShell {
  openExternal(url: string): Promise<void> | void;
}
