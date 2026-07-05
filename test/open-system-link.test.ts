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

  it("falls back to Electron shell.openExternal when no platform opener is available", async () => {
    const openExternal = vi.fn();
    const runtime = runtimeWith({ electron: { shell: { openExternal } } });

    await openSystemUrl("https://example.com/path", runtime);

    expect(openExternal).toHaveBeenCalledWith("https://example.com/path");
  });
});

function runtimeWith(modules: Record<string, unknown>): SystemLinkRuntime {
  return {
    require: (moduleName) => modules[moduleName],
    openWindow: () => null,
  };
}
