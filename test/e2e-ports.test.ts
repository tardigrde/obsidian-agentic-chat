import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import * as ports from "../scripts/e2e-ports";

const servers: net.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

/** Hold an OS-chosen port (listen(0)), so parallel runs never collide on a fixed one. */
function hold(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port));
    servers.push(server);
  });
}

/** A port that was free a moment ago: bind 0, read it, release it. */
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as net.AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// Two e2e runs at once: the second run's chromedriver could not bind 9515, but
// "can I connect to 9515?" said yes (the first run's driver answered), so the
// second run drove the first run's browser and died when that run ended.
describe("e2e driver port choice", () => {
  it("skips a port that another process already listens on", async () => {
    const taken = await hold();
    const free = await freePort();
    const firstFreePort = (ports as { firstFreePort?: (candidates: number[]) => Promise<number | undefined> }).firstFreePort;
    expect(await firstFreePort?.([taken, free])).toBe(free);
  });

  it("reports no port when every candidate is taken", async () => {
    const taken = await hold();
    const firstFreePort = (ports as { firstFreePort?: (candidates: number[]) => Promise<number | undefined> }).firstFreePort;
    expect(await firstFreePort?.([taken])).toBeUndefined();
    expect(firstFreePort).toBeTypeOf("function");
  });

  it("recognizes only our own driver's start line", () => {
    const startedOn = (ports as { driverStartedOn?: (output: string, port: number) => boolean }).driverStartedOn;
    expect(startedOn?.("ChromeDriver was started successfully on port 9612.", 9612)).toBe(true);
    expect(startedOn?.("ChromeDriver was started successfully on port 9515.", 9612)).toBe(false);
    expect(startedOn?.("bind() failed: Address already in use (98)", 9612)).toBe(false);
  });
});
