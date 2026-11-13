import { type App, TAbstractFile, TFile, TFolder } from "obsidian";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { applyExactEditsPartial, type EditApplyResult } from "../../vault/edit";
import type { IgnoreMatcher } from "../../vault/ignore";
import type { ReadMemo } from "../../vault/read-memo";
import { ensureVaultParentFolder } from "../../vault/storage";
import {
  DeleteParameters,
  EditParameters,
  RenameParameters,
  WriteParameters,
  vaultToolDefinition,
} from "../vault-tool-definitions";
import {
  adapterDeletionMessage,
  adapterPathExists,
  inspectAdapterTarget,
  trashAdapterFile,
  trashAdapterFolder,
  trashTreeFolderRecursive,
} from "../vault/adapter-trash";
import { buildEditDiffSummary, formatEditFailures } from "../vault/edit-diff";
import {
  getVisibleVaultFile,
  normalizeVisibleVaultPath,
  textResult,
  untrustedTextResult,
} from "./shared";

export function createWriteTool(app: App, isIgnored: IgnoreMatcher, memo?: ReadMemo): AgentTool<typeof WriteParameters> {
  return {
    ...vaultToolDefinition("write"),
    execute: async (_id, params) => {
      const path = normalizeVisibleVaultPath(isIgnored, params.path);
      await ensureVaultParentFolder(app, path);
      const existing = app.vault.getAbstractFileByPath(path);
      if (existing instanceof TFolder) {
        throw new TypeError(`Cannot write file because a folder exists at ${path}.`);
      }
      if (existing instanceof TFile) {
        await app.vault.process(existing, () => params.content);
      } else {
        await app.vault.create(path, params.content);
      }
      memo?.invalidate(path);
      return textResult(`Wrote ${params.content.length} characters to ${path}.`, {
        path,
        bytes: params.content.length,
      });
    },
  };
}

export function createEditTool(app: App, isIgnored: IgnoreMatcher, memo?: ReadMemo): AgentTool<typeof EditParameters> {
  return {
    ...vaultToolDefinition("edit"),
    execute: async (_id, params) => {
      const { path, file } = getVisibleVaultFile(app, isIgnored, params.path);
      // Partial-apply: edits that match are applied, failures are reported per-edit
      // so one bad oldText no longer sinks the whole batch. The result is captured
      // from the atomic process() transform, which gives us the live file content.
      let before = "";
      let result: EditApplyResult | undefined;
      await app.vault.process(file, (content) => {
        before = content;
        result = applyExactEditsPartial(content, params.edits);
        return result.content;
      });
      if (!result) throw new Error("Edit could not be applied.");
      memo?.invalidate(path);
      return editToolMessage(path, params.edits.length, result, before);
    },
  };
}

/** Build the edit tool's result text from a partial-apply outcome. The
 * `applied`/`failed` arrays in `details` carry the post-placeholder-substitution
 * oldText/newText (and start/end for applied) so the audit captures what
 * actually changed — not just an "Applied N edits" placeholder. PII in the
 * strings is redacted downstream by `redactAuditResult`.
 * When `before` is provided, a concise diff summary is appended so the model
 * can see what changed without issuing a separate read. */
export function editToolMessage(
  path: string,
  total: number,
  result: EditApplyResult,
  before?: string,
): AgentToolResult<Record<string, unknown>> {
  const applied = result.applied.length;
  const failed = result.failed;
  const diffSummary = before !== undefined ? buildEditDiffSummary(before, result.content) : "";
  const details = {
    path,
    editCount: applied,
    failedCount: failed.length,
    applied: result.applied.map((edit) => ({
      oldText: edit.oldText,
      newText: edit.newText,
      start: edit.start,
      end: edit.end,
    })),
    failed: result.failed.map((failure) => ({
      oldText: failure.edit.oldText,
      newText: failure.edit.newText,
      error: failure.error,
    })),
  };
  // Edit messages contain file diffs (file content) when diffSummary is present — treat as untrusted
  if (applied === 0) {
    // Nothing applied — surface every failure so the model can correct them.
    return untrustedTextResult(
      `Applied 0 of ${total} edits to ${path}; none matched. Failures:\n${formatEditFailures(failed)}`,
      details,
      "edit",
    );
  }
  if (failed.length === 0) {
    const base = `Applied ${applied} edit${applied === 1 ? "" : "s"} to ${path}.`;
    const text = diffSummary ? `${base}\n\n${diffSummary}` : base;
    return diffSummary ? untrustedTextResult(text, details, "edit") : textResult(text, details);
  }
  const base = `Applied ${applied} of ${total} edits to ${path}. ${failed.length} not applied:\n${formatEditFailures(failed)}`;
  const text = diffSummary ? `${base}\n\n${diffSummary}` : base;
  return diffSummary ? untrustedTextResult(text, details, "edit") : textResult(text, details);
}

export function createRenameTool(app: App, isIgnored: IgnoreMatcher, memo?: ReadMemo): AgentTool<typeof RenameParameters> {
  return {
    ...vaultToolDefinition("rename"),
    execute: async (_id, params) => {
      const { path, file } = getVisibleVaultFile(app, isIgnored, params.path);
      const newPath = normalizeVisibleVaultPath(isIgnored, params.newPath);
      // Block both the source (invisible) and the destination (no smuggling into an ignored zone).
      if (app.vault.getAbstractFileByPath(newPath)) {
        throw new Error(`Something already exists at ${newPath}.`);
      }
      await ensureVaultParentFolder(app, newPath);
      await app.fileManager.renameFile(file, newPath);
      memo?.invalidate(path);
      memo?.invalidate(newPath);
      return textResult(`Renamed ${path} to ${newPath}.`, { path, newPath });
    },
  };
}

/** Delete via the vault index when present, else the adapter (stale dot-folder tree). */
export function createDeleteTool(app: App, isIgnored: IgnoreMatcher, memo?: ReadMemo): AgentTool<typeof DeleteParameters> {
  return {
    ...vaultToolDefinition("delete"),
    execute: async (_id, params) => {
      const path = normalizeVisibleVaultPath(isIgnored, params.path);
      const recursive = params.recursive === true;
      const entry = app.vault.getAbstractFileByPath(path);
      const indexed = entry ? await deleteIndexedEntry(app, entry, path, recursive, memo) : null;
      return indexed ?? deleteStaleEntry(app, path, recursive, memo);
    },
  };
}

async function deleteIndexedEntry(
  app: App,
  entry: TAbstractFile,
  path: string,
  recursive: boolean,
  memo: ReadMemo | undefined,
): Promise<AgentToolResult<Record<string, unknown>> | null> {
  if (entry instanceof TFile) {
    await app.fileManager.trashFile(entry);
    memo?.invalidate(path);
    return textResult(`Moved ${path} to trash.`, { path, kind: "file" });
  }
  if (!(entry instanceof TFolder)) return null;
  if (entry.children.length > 0 && !recursive) {
    throw new Error(
      `Folder not empty: ${path} (${entry.children.length} items). Use recursive:true or delete the contents first.`,
    );
  }
  if (entry.children.length === 0) {
    await app.fileManager.trashFile(entry);
    memo?.invalidate(path);
    return textResult(`Moved ${path} to trash.`, { path, kind: "folder" });
  }
  // Indexed recursive delete stays on the vault API so the tree and
  // trash semantics match single-file deletes (no adapter needed —
  // works in tests and offline). No per-file undo is captured, so a
  // recursive delete is OS-trash-only: /undo covers single files.
  await trashTreeFolderRecursive(app, entry);
  memo?.invalidate(path);
  return textResult(`Moved ${path} to trash.`, { path, kind: "folder", recursive: true });
}

/**
 * Stale tree: dot-folders (e.g. .agentic-plugins) created outside the session
 * are on disk but missing from the vault index — fall back to the adapter like
 * read/ls do. A missing path still throws here, so "not found" keeps meaning
 * "nowhere", not "stale".
 */
async function deleteStaleEntry(
  app: App,
  path: string,
  recursive: boolean,
  memo: ReadMemo | undefined,
): Promise<AgentToolResult<Record<string, unknown>>> {
  const adapter = app.vault.adapter;
  if (!(await adapterPathExists(adapter, path))) throw new Error(`File or folder not found: ${path}`);
  const target = await inspectAdapterTarget(adapter, path);
  if (target.isFolder) {
    if (target.childCount > 0 && !recursive) {
      throw new Error(
        `Folder not empty: ${path} (${target.childCount} items). Use recursive:true or delete the contents first.`,
      );
    }
    const disposition = await trashAdapterFolder(app, path, recursive);
    memo?.invalidate(path);
    return textResult(adapterDeletionMessage(path, disposition), {
      path,
      kind: "folder",
      staleTree: true,
      ...(recursive ? { recursive: true } : {}),
      ...(disposition === "trash" ? {} : { bypassedTrash: true }),
    });
  }
  const disposition = await trashAdapterFile(app, path);
  memo?.invalidate(path);
  return textResult(adapterDeletionMessage(path, disposition), {
    path,
    kind: "file",
    staleTree: true,
    ...(disposition === "trash" ? {} : { bypassedTrash: true }),
  });
}
