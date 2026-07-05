import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import {
  BUILTIN_TOOL_CONTRACTS,
  BUILTIN_TOOL_NAMES,
  DEFAULT_BUILTIN_TOOL_NAMES,
  MUTATING_TOOLS,
  UNDOABLE_TOOLS,
  approvalPreviewNeedsContent,
  builtinToolExecutionMode,
  builtinToolContractsForSurface,
  builtinToolLabel,
  getBuiltinToolContract,
  isMutatingTool,
  isUndoableTool,
  toolApprovalDescription,
} from "../src/tools/tool-contracts";
import { createVaultTools } from "../src/tools/vault-tools";

describe("built-in tool contracts", () => {
  it("lists every built-in vault tool exactly once", () => {
    const contractNames = BUILTIN_TOOL_CONTRACTS.map((contract) => contract.name);
    expect(contractNames).toEqual([...BUILTIN_TOOL_NAMES]);
    expect(new Set(contractNames).size).toBe(contractNames.length);
  });

  it("drives default and compatibility tool registration order", () => {
    const contractNames = BUILTIN_TOOL_CONTRACTS.map((contract) => contract.name);
    const defaultNames = builtinToolContractsForSurface().map((contract) => contract.name);
    expect(defaultNames).toEqual([...DEFAULT_BUILTIN_TOOL_NAMES]);
    expect(defaultNames).toContain("vault_inspect");
    expect(defaultNames).not.toContain("ls");
    expect(defaultNames).not.toContain("search");
    expect(defaultNames).not.toContain("find");
    expect(defaultNames).not.toContain("grep");
    expect(defaultNames).not.toContain("get_active_note");
    expect(defaultNames).not.toContain("get_backlinks");
    expect(defaultNames).not.toContain("get_links");
    expect(defaultNames).not.toContain("local_graph");
    expect(defaultNames).not.toContain("get_properties");

    const tools = createVaultTools({} as App);
    expect(tools.map((tool) => tool.name)).toEqual(defaultNames);

    const compatibilityTools = createVaultTools({} as App, undefined, undefined, { surface: "compat" });
    expect(compatibilityTools.map((tool) => tool.name)).toEqual(contractNames);
  });

  it("keeps the default prompt surface smaller than the compatibility surface", () => {
    const defaultTools = createVaultTools({} as App);
    const compatibilityTools = createVaultTools({} as App, undefined, undefined, { surface: "compat" });
    const promptFootprint = (tools: ReturnType<typeof createVaultTools>): number =>
      JSON.stringify(
        tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        })),
      ).length;

    expect(defaultTools.length).toBeLessThan(compatibilityTools.length);
    expect(promptFootprint(defaultTools)).toBeLessThan(promptFootprint(compatibilityTools));
  });

  it("is the source of truth for created tool labels and execution mode", () => {
    const tools = createVaultTools({} as App);
    for (const tool of tools) {
      const contract = getBuiltinToolContract(tool.name);
      expect(contract, tool.name).toBeDefined();
      expect(tool.label).toBe(contract?.label);
      expect(tool.executionMode ?? "default").toBe(contract?.executionMode);
    }

    expect(builtinToolLabel("write")).toBe("Write file");
    expect(builtinToolExecutionMode("write")).toBe("sequential");
    expect(builtinToolExecutionMode("read")).toBeUndefined();
  });

  it("derives mutating and undoable sets from contracts", () => {
    const mutating = BUILTIN_TOOL_CONTRACTS.filter((contract) => contract.mutating).map((contract) => contract.name);
    const undoable = BUILTIN_TOOL_CONTRACTS.filter((contract) => contract.undoable).map((contract) => contract.name);

    expect([...MUTATING_TOOLS]).toEqual(mutating);
    expect([...UNDOABLE_TOOLS]).toEqual(undoable);
    expect([...MUTATING_TOOLS]).toEqual(["write", "edit", "rename", "delete", "set_properties"]);
    expect([...UNDOABLE_TOOLS]).toEqual(["write", "edit", "rename", "delete", "set_properties"]);
    for (const tool of UNDOABLE_TOOLS) expect(MUTATING_TOOLS.has(tool)).toBe(true);

    expect(isMutatingTool("set_properties")).toBe(true);
    expect(isMutatingTool("get_properties")).toBe(false);
    expect(isUndoableTool("rename")).toBe(true);
    expect(isUndoableTool("set_properties")).toBe(true);
  });

  it("pins path arguments and ignore-list semantics for sensitive tools", () => {
    expect(getBuiltinToolContract("read")?.pathArgs).toEqual([{ name: "path", required: true, kind: "file" }]);
    expect(getBuiltinToolContract("vault_inspect")?.pathArgs).toEqual([{ name: "path", required: false, kind: "search-root" }]);
    expect(getBuiltinToolContract("search")?.pathArgs).toEqual([{ name: "path", required: false, kind: "search-root" }]);
    expect(getBuiltinToolContract("grep")?.pathArgs).toEqual([{ name: "path", required: false, kind: "search-root" }]);
    expect(getBuiltinToolContract("find")?.pathArgs).toEqual([]);
    expect(getBuiltinToolContract("rename")?.pathArgs).toEqual([
      { name: "path", required: true, kind: "file" },
      { name: "newPath", required: true, kind: "destination" },
    ]);
    expect(getBuiltinToolContract("delete")?.pathArgs).toEqual([{ name: "path", required: true, kind: "file-or-folder" }]);

    expect(getBuiltinToolContract("read")?.ignoreBehavior).toBe("target-hidden");
    expect(getBuiltinToolContract("rename")?.ignoreBehavior).toBe("source-and-destination-hidden");
    expect(getBuiltinToolContract("get_active_note")?.ignoreBehavior).toBe("active-note-hidden");
    expect(getBuiltinToolContract("search")?.ignoreBehavior).toBe("results-filtered");
    expect(getBuiltinToolContract("local_graph")?.ignoreBehavior).toBe("target-and-linked-results-hidden");
  });

  it("pins approval copy and preview content reads", () => {
    expect(getBuiltinToolContract("write")?.approval.preview).toBe("diff");
    expect(getBuiltinToolContract("edit")?.approval.preview).toBe("diff");
    expect(getBuiltinToolContract("delete")?.approval.preview).toBe("delete");
    expect(getBuiltinToolContract("rename")?.approval.preview).toBe("rename");
    expect(getBuiltinToolContract("set_properties")?.approval.preview).toBe("none");

    expect(approvalPreviewNeedsContent("write")).toBe(true);
    expect(approvalPreviewNeedsContent("edit")).toBe(true);
    expect(approvalPreviewNeedsContent("delete")).toBe(true);
    expect(approvalPreviewNeedsContent("rename")).toBe(false);
    expect(approvalPreviewNeedsContent("set_properties")).toBe(false);

    expect(toolApprovalDescription("write")).toMatch(/overwrite a vault file/i);
    expect(toolApprovalDescription("delete")).toMatch(/file or empty folder/i);
    expect(toolApprovalDescription("web_search")).toMatch(/run the web_search tool/i);
  });

  it("handles unknown tool names without classifying them as built-in vault tools", () => {
    expect(getBuiltinToolContract("web_search")).toBeUndefined();
    expect(isMutatingTool("web_search")).toBe(false);
    expect(isUndoableTool("web_search")).toBe(false);
    expect(approvalPreviewNeedsContent("web_search")).toBe(false);
  });
});
