import { beforeEach, describe, expect, it } from "vitest";
import type { App } from "obsidian";
import { ModelRetry } from "../src/agent/errors";
import type { RunContext } from "../src/agent/tool";
import { emptyUsage } from "../src/agent/types";
import {
  VaultDeps,
  getActiveNote,
  listFolder,
  readNote,
  searchVault,
  vaultTools,
  writeNote,
} from "../src/tools/vault-tools";
import { FakeApp } from "./helpers/fake-vault";

let app: FakeApp;
let ctx: RunContext<VaultDeps>;

beforeEach(async () => {
  app = new FakeApp();
  ctx = { deps: { app: app as unknown as App }, usage: emptyUsage(), retry: 0 };
  await app.vault.createFolder("Projects");
  await app.vault.create("Projects/Ideas.md", "# Ideas\n\nbuild an obsidian agent");
  await app.vault.create("Daily.md", "today I reviewed the agent design");
});

describe("read_note", () => {
  it("returns the note content", async () => {
    await expect(readNote.execute({ path: "Projects/Ideas.md" }, ctx)).resolves.toContain(
      "build an obsidian agent",
    );
  });

  it("normalizes leading slashes in paths", async () => {
    await expect(readNote.execute({ path: "/Daily.md" }, ctx)).resolves.toContain("reviewed");
  });

  it("throws ModelRetry for missing notes so the agent can recover", async () => {
    await expect(readNote.execute({ path: "nope.md" }, ctx)).rejects.toThrow(ModelRetry);
  });
});

describe("write_note", () => {
  it("creates a new note and reports it", async () => {
    const result = await writeNote.execute(
      { path: "New.md", content: "hello", mode: "create" },
      ctx,
    );

    expect(result).toContain('Created "New.md"');
    expect(app.vault.contentOf("New.md")).toBe("hello");
  });

  it("creates missing parent folders automatically", async () => {
    await writeNote.execute({ path: "a/b/c/Deep.md", content: "deep", mode: "create" }, ctx);

    expect(app.vault.hasFolder("a")).toBe(true);
    expect(app.vault.hasFolder("a/b")).toBe(true);
    expect(app.vault.hasFolder("a/b/c")).toBe(true);
    expect(app.vault.contentOf("a/b/c/Deep.md")).toBe("deep");
  });

  it("refuses to create over an existing note", async () => {
    await expect(
      writeNote.execute({ path: "Daily.md", content: "x", mode: "create" }, ctx),
    ).rejects.toThrow(ModelRetry);
  });

  it("overwrites existing content in overwrite mode", async () => {
    await writeNote.execute({ path: "Daily.md", content: "fresh", mode: "overwrite" }, ctx);

    expect(app.vault.contentOf("Daily.md")).toBe("fresh");
  });

  it("appends with a separating newline", async () => {
    await writeNote.execute({ path: "Daily.md", content: "more", mode: "append" }, ctx);

    expect(app.vault.contentOf("Daily.md")).toBe(
      "today I reviewed the agent design\nmore",
    );
  });

  it("creates the note when appending to a missing path", async () => {
    const result = await writeNote.execute(
      { path: "Fresh.md", content: "x", mode: "append" },
      ctx,
    );

    expect(result).toContain("did not exist");
    expect(app.vault.contentOf("Fresh.md")).toBe("x");
  });
});

describe("list_folder", () => {
  it("lists the vault root with folder markers", () => {
    const result = listFolder.execute({ path: "/" }, ctx) as string;

    expect(result.split("\n")).toEqual(["Daily.md", "Projects/"]);
  });

  it("lists a subfolder", () => {
    expect(listFolder.execute({ path: "Projects" }, ctx)).toBe("Ideas.md");
  });

  it("throws ModelRetry for unknown folders", () => {
    expect(() => listFolder.execute({ path: "Missing" }, ctx)).toThrow(ModelRetry);
  });
});

describe("search_vault", () => {
  it("finds notes by content with a snippet", async () => {
    const result = await searchVault.execute({ query: "agent design" }, ctx);

    expect(result).toContain("Daily.md");
    expect(result).toContain("agent design");
  });

  it("finds notes by file name", async () => {
    const result = await searchVault.execute({ query: "ideas" }, ctx);

    expect(result).toContain("Projects/Ideas.md");
  });

  it("respects the result limit", async () => {
    const result = await searchVault.execute({ query: "agent", limit: 1 }, ctx);

    expect(result).toContain("Found 1 match(es)");
  });

  it("reports when nothing matches", async () => {
    await expect(searchVault.execute({ query: "zzz-nothing" }, ctx)).resolves.toContain(
      "No notes matched",
    );
  });
});

describe("get_active_note", () => {
  it("returns the active note path and content", async () => {
    app.activeFile = app.vault.getMarkdownFiles().find((f) => f.path === "Daily.md") ?? null;

    const result = await getActiveNote.execute({}, ctx);

    expect(result).toContain("Active note: Daily.md");
    expect(result).toContain("reviewed the agent design");
  });

  it("reports gracefully when no note is active", async () => {
    await expect(getActiveNote.execute({}, ctx)).resolves.toContain("No note is currently active");
  });
});

describe("vaultTools", () => {
  it("exposes the five built-in tools with unique names", () => {
    const names = vaultTools().map((tool) => tool.name);

    expect(names).toEqual([
      "read_note",
      "write_note",
      "list_folder",
      "search_vault",
      "get_active_note",
    ]);
    expect(new Set(names).size).toBe(names.length);
  });
});
