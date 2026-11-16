import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import type { ToolArtifactStoreLike } from "../src/artifacts/tool-artifact-store";
import { AgentRuntimeResourceState } from "../src/agent/runtime-resource-state";
import { DEFAULT_SETTINGS } from "../src/settings-schema";
import type { WebFetcher } from "../src/tools/web-fetch";
import { ReadMemo } from "../src/vault/read-memo";
import { FakeApp } from "./helpers/fake-vault";

/**
 * Card 1 (tool consolidation) witness. It uses only the API that exists before
 * and after the change, so the old code fails these checks with assertions.
 */
const noopWebFetch: WebFetcher = async () => ({ status: 200, text: "", headers: {} });

async function loadedState(): Promise<AgentRuntimeResourceState> {
  const state = new AgentRuntimeResourceState({
    app: new FakeApp() as unknown as App,
    getSettings: () => DEFAULT_SETTINGS,
    readMemo: new ReadMemo(),
    webFetch: noopWebFetch,
    // Construction only: the artifact and document tools need a store to exist.
    artifactStore: {} as ToolArtifactStoreLike,
  });
  await state.reload();
  return state;
}

describe("tool consolidation (card 1)", () => {
  it("sends the merged tools and search_tools, and none of the old names", async () => {
    const names = (await loadedState()).buildParentTools(DEFAULT_SETTINGS).map((tool) => tool.name);

    expect(names).toEqual(expect.arrayContaining(["vault_inspect", "skill", "artifact", "current_time", "search_tools"]));
    for (const gone of [
      "read_skill",
      "read_skill_file",
      "load_skill",
      "unload_skill",
      "list_artifacts",
      "read_artifact",
      "search_artifact",
      "export_artifact",
    ]) {
      expect(names, gone).not.toContain(gone);
    }
    // Deferred until search_tools loads it.
    expect(names).not.toContain("import_document");
  });

  it("keeps the date out of the system prompt", async () => {
    const prompt = (await loadedState()).composeSystemPrompt(DEFAULT_SETTINGS, "test/model");

    expect(prompt).not.toMatch(/Today is /);
    expect(prompt).toContain("## Deferred tools");
    expect(prompt).toContain("- import_document:");
  });

  it("has no tool budget setting", () => {
    expect("toolBudget" in DEFAULT_SETTINGS).toBe(false);
  });
});
