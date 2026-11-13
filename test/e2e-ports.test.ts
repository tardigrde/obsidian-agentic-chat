import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import * as ports from "../scripts/e2e-ports";

const servers: net.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

function hold(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
    servers.push(server);
  });
}

// Two e2e runs at once: the second run's chromedriver could not bind 9515, but
// "can I connect to 9515?" said yes (the first run's driver answered), so the
// second run drove the first run's browser and died when that run ended.
describe("e2e driver port choice", () => {
  it("skips a port that another process already listens on", async () => {
    await hold(9611);
    const firstFreePort = (ports as { firstFreePort?: (candidates: number[]) => Promise<number | undefined> }).firstFreePort;
    expect(await firstFreePort?.([9611, 9612])).toBe(9612);
  });

  it("reports no port when every candidate is taken", async () => {
    await hold(9613);
    const firstFreePort = (ports as { firstFreePort?: (candidates: number[]) => Promise<number | undefined> }).firstFreePort;
    expect(await firstFreePort?.([9613])).toBeUndefined();
    expect(firstFreePort).toBeTypeOf("function");
  });

  it("recognizes only our own driver's start line", () => {
    const startedOn = (ports as { driverStartedOn?: (output: string, port: number) => boolean }).driverStartedOn;
    expect(startedOn?.("ChromeDriver was started successfully on port 9612.", 9612)).toBe(true);
    expect(startedOn?.("ChromeDriver was started successfully on port 9515.", 9612)).toBe(false);
    expect(startedOn?.("bind() failed: Address already in use (98)", 9612)).toBe(false);
  });
});
