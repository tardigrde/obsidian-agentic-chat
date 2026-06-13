import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import { loadVaultPromptTemplates, loadVaultSkills } from "../src/skills/skills";
import { FakeApp } from "./helpers/fake-vault";

async function seed(): Promise<App> {
  const app = new FakeApp();
  await app.vault.createFolder("Skills");
  await app.vault.create(
    "Skills/summarize.md",
    "---\nname: Summarize\ndescription: Summarize the active note\n---\nWrite a 3-bullet summary.",
  );
  await app.vault.createFolder("Templates");
  await app.vault.create("Templates/daily.md", "Summarize daily note $1 and extract tasks.");
  return app as unknown as App;
}

describe("loadVaultSkills", () => {
  it("parses frontmatter name/description and keeps the body as content", async () => {
    const skills = await loadVaultSkills(await seed(), "Skills");
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      name: "Summarize",
      description: "Summarize the active note",
      filePath: "Skills/summarize.md",
    });
    expect(skills[0].content).toContain("3-bullet summary");
  });

  it("returns nothing when no folder is configured", async () => {
    expect(await loadVaultSkills(await seed(), "")).toEqual([]);
  });
});

describe("loadVaultPromptTemplates", () => {
  it("loads markdown templates from the folder", async () => {
    const templates = await loadVaultPromptTemplates(await seed(), "Templates");
    expect(templates).toHaveLength(1);
    expect(templates[0].name).toBe("daily");
    expect(templates[0].content).toContain("$1");
  });
});
