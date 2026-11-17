import { readdirSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isLoopbackHost } from "./support/offline-guard";

/** T1 stays hermetic: no remote calls, no fixed ports. */

describe("offline guard (installed by test/setup.ts)", () => {
  it("rejects fetch to a non-local host before any request leaves", async () => {
    await expect(fetch("https://example.com/")).rejects.toThrow(/offline guard: a T1 test tried to reach example\.com/);
  });

  it("rejects a raw socket to a remote host", async () => {
    const error = await new Promise<Error>((resolve) => {
      const socket = net.connect({ host: "example.com", port: 443 });
      socket.once("error", resolve);
    });
    expect(error.message).toMatch(/offline guard/);
  });

  it("lets a local server on an OS-chosen port answer", async () => {
    const server = http.createServer((_req, res) => res.end("local ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    try {
      const { port } = server.address() as net.AddressInfo;
      expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("local ok");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("treats only loopback names as local", () => {
    for (const host of ["localhost", "127.0.0.1", "127.3.4.5", "::1", "[::1]", "app.localhost"]) expect(isLoopbackHost(host)).toBe(true);
    for (const host of ["example.com", "10.0.0.1", "localhost.evil.com", "openrouter.ai"]) expect(isLoopbackHost(host)).toBe(false);
  });
});

function testFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === "e2e" || name === "fixtures" ? [] : testFiles(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

describe("no fixed ports", () => {
  it("no unit test or test helper binds a fixed port; use listen(0)", () => {
    const offenders = testFiles(path.resolve("test")).filter((file) => /\.listen\(\s*[1-9]\d*/.test(readFileSync(file, "utf8")));
    expect(offenders.map((file) => path.relative(process.cwd(), file))).toEqual([]);
  });
});
