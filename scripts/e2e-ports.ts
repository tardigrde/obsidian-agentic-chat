import net from "node:net";

/** True when nothing listens on 127.0.0.1:<port> (we can bind it ourselves). */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

/** The first candidate port that is free right now, or undefined. */
export async function firstFreePort(candidates: readonly number[]): Promise<number | undefined> {
  for (const port of candidates) {
    if (await isPortFree(port)) return port;
  }
  return undefined;
}

/**
 * True when this driver output says the driver WE started listens on `port`.
 * A plain connect test is not enough: another run's driver on the same port
 * also accepts the connection.
 */
export function driverStartedOn(output: string, port: number): boolean {
  return new RegExp(`started successfully on port ${port}\\b`).test(output);
}
