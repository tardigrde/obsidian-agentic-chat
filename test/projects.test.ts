import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, activeModelId, mergeSettings } from "../src/settings";
import {
  activeProject,
  effectiveProjectSettings,
  healProjectSettings,
  isPathInProjectScope,
  projectSessionScope,
  resolveProjectCommand,
} from "../src/projects/projects";

describe("project settings", () => {
  it("heals stored projects and drops an invalid active project id", () => {
    const healed = healProjectSettings({
      activeProjectId: "missing",
      items: [
        {
          id: "Alpha Project!",
          name: " Alpha Project ",
          folders: ["Projects/Alpha", "/", "../bad", "Projects/Alpha"],
          modelId: " openai/gpt-4o-mini ",
          profile: "learning",
          systemPrompt: " Use alpha terminology. ",
          tools: { web: false, mcp: true },
        },
        { id: "Alpha Project!", name: "Duplicate Alpha", folders: ["Projects/Dupe"] },
        { id: "", name: "", folders: ["Ignored"] },
      ],
    });

    expect(healed.activeProjectId).toBe("");
    expect(healed.items).toEqual([
      expect.objectContaining({
        id: "alpha-project",
        name: "Alpha Project",
        folders: ["Projects/Alpha", ""],
        modelId: "openai/gpt-4o-mini",
        profile: "learning",
        systemPrompt: "Use alpha terminology.",
        tools: { web: false, mcp: true },
      }),
      expect.objectContaining({ id: "alpha-project-2", name: "Duplicate Alpha" }),
    ]);
  });

  it("merges projects and resolves active project state", () => {
    const settings = mergeSettings({
      projects: {
        activeProjectId: "alpha",
        items: [{ id: "alpha", name: "Alpha", folders: ["Projects/Alpha"] }],
      },
    });

    expect(activeProject(settings.projects)).toMatchObject({ id: "alpha", name: "Alpha" });
    expect(projectSessionScope(settings.projects)).toEqual({ projectId: "alpha", projectName: "Alpha" });
  });

  it("applies project model, profile, system context, tool gates, and folder scope", () => {
    const settings = mergeSettings({
      ...DEFAULT_SETTINGS,
      openrouterModel: "base/model",
      outputStyle: "default",
      web: { ...DEFAULT_SETTINGS.web, enabled: true },
      mcp: { ...DEFAULT_SETTINGS.mcp, enabled: false },
      projects: {
        activeProjectId: "alpha",
        items: [
          {
            id: "alpha",
            name: "Alpha",
            folders: ["Projects/Alpha"],
            modelId: "project/model",
            profile: "brainstorm",
            systemPrompt: "Prefer the alpha glossary.",
            tools: { web: false, mcp: true },
          },
        ],
      },
    });

    const effective = effectiveProjectSettings(settings);

    expect(activeModelId(effective)).toBe("project/model");
    expect(effective.outputStyle).toBe("brainstorm");
    expect(effective.approval.workingDirs).toEqual(["Projects/Alpha"]);
    expect(effective.web.enabled).toBe(false);
    expect(effective.mcp.enabled).toBe(true);
    expect(effective.systemPrompt).toContain("Project: Alpha");
    expect(effective.systemPrompt).toContain("Prefer the alpha glossary.");
    expect(isPathInProjectScope("Projects/Alpha/Note.md", ["Projects/Alpha"])).toBe(true);
    expect(isPathInProjectScope("Projects/Beta/Note.md", ["Projects/Alpha"])).toBe(false);
  });

  it("resolves /project command arguments against project settings", () => {
    const projects = {
      activeProjectId: "alpha",
      items: [
        { id: "alpha", name: "Alpha Project", folders: ["Projects/Alpha"] },
        { id: "beta", name: "Client Beta", folders: ["Clients/Beta"] },
      ],
    };

    expect(resolveProjectCommand("", projects)).toEqual({ action: "list" });
    expect(resolveProjectCommand(" vault-wide ", projects)).toEqual({ action: "activate", projectId: "" });
    expect(resolveProjectCommand("BETA", projects)).toEqual({ action: "activate", projectId: "beta" });
    expect(resolveProjectCommand("client beta", projects)).toEqual({ action: "activate", projectId: "beta" });
    expect(resolveProjectCommand("missing", projects)).toEqual({
      action: "error",
      message: 'Unknown project "missing".',
    });
  });
});
