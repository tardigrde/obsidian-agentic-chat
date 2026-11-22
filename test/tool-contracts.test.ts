import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import {
  BUILTIN_TOOL_CONTRACTS,
  BUILTIN_TOOL_NAMES,
  MUTATING_TOOLS,
  UNDOABLE_TOOLS,
  approvalPreviewNeedsContent,
  builtinToolExecutionMode,
  builtinToolLabel,
  getBuiltinToolContract,
  toolApprovalDescription,
} from "../src/tools/tool-contracts";
import { createVaultTools } from "../src/tools/vault-tools";

describe("built-in tool contracts", () => {
  it("lists every built-in vault tool exactly once", () => {
    const contractNames = BUILTIN_TOOL_CONTRACTS.map((contract) => contract.name);
    expect(contractNames).toEqual([...BUILTIN_TOOL_NAMES]);
    expect(new Set(contractNames).size).toBe(contractNames.length);
  });

  it("drives tool registration order; the old standalone inspect tools are gone", () => {
    const contractNames = BUILTIN_TOOL_CONTRACTS.map((contract) => contract.name);
    expect(contractNames).toEqual(["read", "vault_inspect", "write", "edit", "rename", "delete", "set_properties"]);
    for (const removed of ["ls", "search", "find", "grep", "get_active_note", "get_backlinks", "get_links", "local_graph", "get_properties"]) {
      expect(getBuiltinToolContract(removed), removed).toBeUndefined();
    }
    expect(createVaultTools({} as App).map((tool) => tool.name)).toEqual(contractNames);
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

    // The vault contracts, plus download_file: a web tool that writes a file (U7 #10).
    expect([...MUTATING_TOOLS]).toEqual([...mutating, "download_file"]);
    expect([...UNDOABLE_TOOLS]).toEqual(undoable);
    expect([...MUTATING_TOOLS]).toEqual(["write", "edit", "rename", "delete", "set_properties", "download_file"]);
    expect([...UNDOABLE_TOOLS]).toEqual(["write", "edit", "rename", "delete", "set_properties"]);
    for (const tool of UNDOABLE_TOOLS) expect(MUTATING_TOOLS.has(tool)).toBe(true);

  });

  it("pins path arguments and ignore-list semantics for sensitive tools", () => {
    expect(getBuiltinToolContract("read")?.pathArgs).toEqual([{ name: "path", required: true, kind: "file" }]);
    expect(getBuiltinToolContract("vault_inspect")?.pathArgs).toEqual([{ name: "path", required: false, kind: "search-root" }]);
    expect(getBuiltinToolContract("rename")?.pathArgs).toEqual([
      { name: "path", required: true, kind: "file" },
      { name: "newPath", required: true, kind: "destination" },
    ]);
    expect(getBuiltinToolContract("delete")?.pathArgs).toEqual([{ name: "path", required: true, kind: "file-or-folder" }]);

    expect(getBuiltinToolContract("read")?.ignoreBehavior).toBe("target-hidden");
    expect(getBuiltinToolContract("rename")?.ignoreBehavior).toBe("source-and-destination-hidden");
    expect(getBuiltinToolContract("vault_inspect")?.ignoreBehavior).toBe("results-filtered");
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
    expect(toolApprovalDescription("delete")).toMatch(/file or folder/i);
    expect(toolApprovalDescription("web_search")).toMatch(/run the web_search tool/i);
  });


  it("handles unknown tool names without classifying them as built-in vault tools", () => {
    expect(getBuiltinToolContract("web_search")).toBeUndefined();
    expect(approvalPreviewNeedsContent("web_search")).toBe(false);
  });
});
