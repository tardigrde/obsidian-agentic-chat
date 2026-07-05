import type { AgentProject } from "../projects/projects";
import type { RetrievalIndexScope } from "../retrieval/policy";
import { normalizeFolderPath } from "../vault/path";

export interface SemanticIndexScopeContext {
  activeProject?: Pick<AgentProject, "name" | "folders">;
  activeNotePath?: string | null;
}

export type ParsedSemanticIndexScope =
  | { scope: RetrievalIndexScope; confirmVault: boolean }
  | { error: string };

export function parseSemanticIndexScopeCommand(
  tokens: readonly string[],
  context: SemanticIndexScopeContext = {},
): ParsedSemanticIndexScope {
  const confirmVault = tokens.includes("--confirm-vault");
  const args = tokens.filter((token) => token !== "--confirm-vault");
  const [kind = "", ...rest] = args;
  const lower = kind.toLowerCase();

  if (!lower) return defaultSemanticIndexScope(context, confirmVault);

  if (lower === "folder") {
    const folder = rest.join(" ").trim();
    if (!folder) return { error: "Usage: /semantic-index start folder <path>" };
    return folderSemanticIndexScope(folder, confirmVault);
  }

  if (lower === "tag") {
    const tag = rest.join(" ").trim().replace(/^#/, "");
    if (!tag) return { error: "Usage: /semantic-index start tag <tag>" };
    return { scope: { kind: "tag", label: `#${tag}`, tags: [tag] }, confirmVault };
  }

  if (lower === "project") {
    const project = context.activeProject;
    if (!project) return { error: "No project is active. Use /project first, or choose a folder/tag/vault scope." };
    return { scope: { kind: "project", label: project.name, paths: project.folders }, confirmVault };
  }

  if (lower === "vault") {
    return { scope: { kind: "vault", label: "Whole vault" }, confirmVault };
  }

  return { error: `Unknown semantic index scope "${kind}". Use folder, tag, project, or vault.` };
}

function defaultSemanticIndexScope(
  context: SemanticIndexScopeContext,
  confirmVault: boolean,
): ParsedSemanticIndexScope {
  const project = context.activeProject;
  if (project) return { scope: { kind: "project", label: project.name, paths: project.folders }, confirmVault };

  const activeFolder = activeNoteFolder(context.activeNotePath);
  if (activeFolder !== null) {
    return { scope: { kind: "folder", label: activeFolder || "/", paths: [activeFolder] }, confirmVault };
  }

  return { error: "Choose a scope: folder <path>, tag <tag>, project, or vault --confirm-vault." };
}

function folderSemanticIndexScope(folder: string, confirmVault: boolean): ParsedSemanticIndexScope {
  let normalized: string;
  try {
    normalized = normalizeFolderPath(folder === "/" ? "" : folder);
  } catch {
    return { error: `Invalid folder path "${folder}".` };
  }
  return { scope: { kind: "folder", label: normalized || "/", paths: [normalized] }, confirmVault };
}

function activeNoteFolder(path: string | null | undefined): string | null {
  if (!path) return null;
  return path.split("/").slice(0, -1).join("/");
}
