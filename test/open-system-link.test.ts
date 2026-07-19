import { describe, expect, it, vi } from "vitest";
import { openSystemUrl, type SystemLinkRuntime } from "../src/ui/open-system-link";

describe("openSystemUrl", () => {
  it("prefers the Windows browser bridge when running under WSL", async () => {
    const execFile = vi.fn((command, _args, _options, callback: (error: Error | null) => void) => {
      callback(command === "rundll32.exe" ? null : new Error("unexpected fallback"));
    });
    const runtime = runtimeWith({
      process: { platform: "linux", env: { WSL_INTEROP: "/run/WSL/1_interop" } },
      child_process: { execFile },
    });

    await openSystemUrl("https://example.com/path", runtime);

    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile.mock.calls[0]?.[0]).toBe("rundll32.exe");
    expect(execFile.mock.calls[0]?.[1]).toEqual(["url.dll,FileProtocolHandler", "https://example.com/path"]);
  });

  it("walks the WSL bridge fallbacks until one succeeds", async () => {
    const execFile = vi.fn((command, _args, _options, callback: (error: Error | null) => void) => {
      callback(command === "wslview" ? null : new Error("nope"));
    });
    const runtime = runtimeWith({
      process: { platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" } },
      child_process: { execFile },
    });

    await openSystemUrl("https://example.com/path", runtime);

    expect(execFile.mock.calls.map((call) => call[0])).toEqual(["rundll32.exe", "explorer.exe", "wslview"]);
  });

  it("uses the win32 cmd start opener", async () => {
    const execFile = vi.fn((_command, _args, _options, callback: (error: Error | null) => void) => callback(null));
    const runtime = runtimeWith({ process: { platform: "win32" }, child_process: { execFile } });

    await openSystemUrl("https://example.com/path", runtime);

    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile.mock.calls[0]?.slice(0, 2)).toEqual(["cmd.exe", ["/c", "start", "", "https://example.com/path"]]);
  });

  it("uses the macOS open opener", async () => {
    const execFile = vi.fn((_command, _args, _options, callback: (error: Error | null) => void) => callback(null));
    const runtime = runtimeWith({ process: { platform: "darwin" }, child_process: { execFile } });

    await openSystemUrl("https://example.com/path", runtime);

    expect(execFile.mock.calls[0]?.[0]).toBe("open");
  });

  it("uses xdg-open on non-WSL Linux", async () => {
    const execFile = vi.fn((_command, _args, _options, callback: (error: Error | null) => void) => callback(null));
    const runtime = runtimeWith({ process: { platform: "linux", env: {} }, child_process: { execFile } });

    await openSystemUrl("https://example.com/path", runtime);

    expect(execFile.mock.calls.map((call) => call[0])).toEqual(["xdg-open"]);
  });

  it("falls back to Electron shell.openExternal when no platform opener is available", async () => {
    const openExternal = vi.fn();
    const runtime = runtimeWith({ electron: { shell: { openExternal } } });

    await openSystemUrl("https://example.com/path", runtime);

    expect(openExternal).toHaveBeenCalledWith("https://example.com/path");
  });

  it("falls back to opening a browser window when nothing else is available", async () => {
    const openWindow = vi.fn(() => ({}) as Window);
    const runtime: SystemLinkRuntime = { require: () => undefined, openWindow };

    await openSystemUrl("https://example.com/path", runtime);

    expect(openWindow).toHaveBeenCalledWith("https://example.com/path");
  });

  it("throws when no opener can handle the link", async () => {
    const runtime: SystemLinkRuntime = { require: () => undefined, openWindow: () => null };

    await expect(openSystemUrl("https://example.com/path", runtime)).rejects.toThrow(/Could not open the link/);
  });

  it("treats a throwing execFile as a failed opener and keeps falling back", async () => {
    const openExternal = vi.fn();
    const execFile = vi.fn(() => {
      throw new Error("spawn failed");
    });
    const runtime = runtimeWith({
      process: { platform: "linux", env: {} },
      child_process: { execFile },
      electron: { shell: { openExternal } },
    });

    await openSystemUrl("https://example.com/path", runtime);

    expect(execFile).toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledWith("https://example.com/path");
  });
});

function runtimeWith(modules: Record<string, unknown>): SystemLinkRuntime {
  return {
    require: (moduleName) => modules[moduleName],
    openWindow: () => null,
  };
}
