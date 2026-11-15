import { describe, expect, it } from "vitest";
import {
  displaySocket,
  normalizeDisplay,
  parseArgs,
} from "../scripts/run-nested.mjs";

describe("nested display helper", () => {
  it("takes the command after an optional separator", () => {
    expect(parseArgs(["npm", "run", "verify", "--", "e2e"]).command).toEqual([
      "npm",
      "run",
      "verify",
      "--",
      "e2e",
    ]);
    expect(parseArgs(["--", "npm", "run", "verify"]).command).toEqual(["npm", "run", "verify"]);
  });

  it("parses screen, title, and display options before the command", () => {
    const parsed = parseArgs([
      "--screen",
      "390x844",
      "--title",
      "mobile e2e",
      "--display",
      ":7",
      "--",
      "npm",
      "run",
      "verify",
    ]);

    expect(parsed.screen).toBe("390x844");
    expect(parsed.title).toBe("mobile e2e");
    expect(parsed.display).toBe(7);
    expect(parsed.command).toEqual(["npm", "run", "verify"]);
  });

  it("stops option parsing at the first command token", () => {
    const parsed = parseArgs(["npm", "run", "verify", "--", "e2e", "--screen", "1x1"]);

    expect(parsed.command).toEqual(["npm", "run", "verify", "--", "e2e", "--screen", "1x1"]);
    expect(parsed.screen).toBe("1440x1000");
  });

  it("normalizes :N and N display values and rejects the rest", () => {
    expect(normalizeDisplay(":12")).toBe(12);
    expect(normalizeDisplay("12")).toBe(12);
    expect(() => normalizeDisplay(":abc")).toThrow(/--display must look like/);
    expect(() => normalizeDisplay(":1.5")).toThrow(/--display must look like/);
  });

  it("rejects an option without a value", () => {
    expect(() => parseArgs(["--screen"])).toThrow(/--screen needs a value/);
    expect(() => parseArgs(["--display", "--", "npm"])).toThrow(/--display needs a value/);
  });

  it("builds the X socket path for a display", () => {
    expect(displaySocket(104)).toBe("/tmp/.X11-unix/X104");
  });

  it("reads --help without a command", () => {
    const parsed = parseArgs(["--help"]);
    expect(parsed.help).toBe(true);
    expect(parsed.command).toEqual([]);
  });

  it("does not run the CLI when the module is imported", () => {
    // Reaching this assertion proves the import guard: without it, main() would
    // print usage and set process.exitCode from the vitest argv.
    expect(process.exitCode ?? 0).toBe(0);
  });
});
