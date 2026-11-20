import { afterEach, describe, expect, it } from "vitest";
import { fakeApp, seedFile } from "./support/mount-chat-view";
import { shownNotices } from "./support/obsidian-dom";
import { openVaultPath } from "../../src/ui/vault-open";

/** U3 #4: chat links open notes only; a folder or a missing path never creates a note. */

afterEach(() => {
  shownNotices.length = 0;
});

describe("openVaultPath", () => {
  it("opens a note, with its heading subpath", async () => {
    const fake = fakeApp();
    await seedFile(fake, "Notes/Plan.md");
    openVaultPath(fake.app, "Notes/Plan.md");
    openVaultPath(fake.app, "Notes/Plan.md#Steps");
    openVaultPath(fake.app, "Plan.md"); // basename, through the metadata cache
    expect(fake.workspace.opened).toEqual(["Notes/Plan.md", "Notes/Plan.md#Steps", "Notes/Plan.md"]);
  });

  it("never opens a folder (with or without a trailing slash) or a missing path", async () => {
    const fake = fakeApp();
    await seedFile(fake, "Shared/inside.md");
    openVaultPath(fake.app, "Shared");
    openVaultPath(fake.app, "Shared/");
    openVaultPath(fake.app, "Missing/Note");
    openVaultPath(fake.app, "#only-a-heading");
    expect(fake.workspace.opened).toEqual([]);
    expect(fake.vault.getAbstractFileByPath("Shared.md")).toBeNull();
    expect(shownNotices).toEqual(["Shared is a folder.", "Shared is a folder.", "Not found in the vault: Missing/Note"]);
  });
});
