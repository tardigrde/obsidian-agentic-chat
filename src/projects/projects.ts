import type { AgenticChatSettings } from "../settings";
import { OUTPUT_STYLES, type OutputStyle } from "../agent/output-styles";
import { normalizeFolderPath, normalizeVaultPath } from "../vault/path";

export interface ProjectToolSettings {
  web?: boolean;
  mcp?: boolean;
}

export interface AgentProject {
  id: string;
  name: string;
  folders: readonly string[];
  modelId?: string;
  profile?: OutputStyle;
  systemPrompt?: string;
  tools?: ProjectToolSettings;
}

export interface ProjectSettings {
  activeProjectId: string;
  items: readonly AgentProject[];
}

export interface ProjectSessionScope {
  projectId?: string;
  projectName?: string;
}

export type ProjectCommandResolution =
  | { action: "list" }
  | { action: "activate"; projectId: string }
  | { action: "error"; message: string };

export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  activeProjectId: "",
  items: [],
};

export function healProjectSettings(stored: unknown): ProjectSettings {
  if (!stored || typeof stored !== "object") return DEFAULT_PROJECT_SETTINGS;
  const input = stored as Record<string, unknown>;
  const items = dedupeProjects(Array.isArray(input.items) ? input.items.map(healProject).filter(isProject) : []);
  const activeProjectId = stringValue(input.activeProjectId);
  return {
    activeProjectId: items.some((project) => project.id === activeProjectId) ? activeProjectId : "",
    items,
  };
}

export function activeProject(settings: ProjectSettings): AgentProject | undefined {
  if (!settings.activeProjectId) return undefined;
  return settings.items.find((project) => project.id === settings.activeProjectId);
}

export function resolveProjectCommand(arg: string, settings: Pick<ProjectSettings, "items">): ProjectCommandResolution {
  const trimmed = arg.trim();
  if (!trimmed) return { action: "list" };
  if (isClearProjectCommand(trimmed)) return { action: "activate", projectId: "" };
  const project = findProject(settings.items, trimmed);
  if (!project) return { action: "error", message: `Unknown project "${trimmed}".` };
  return { action: "activate", projectId: project.id };
}

export function projectSessionScope(settings: ProjectSettings): ProjectSessionScope {
  const project = activeProject(settings);
  return project ? { projectId: project.id, projectName: project.name } : {};
}

export function effectiveProjectSettings(settings: AgenticChatSettings): AgenticChatSettings {
  const project = activeProject(settings.projects);
  if (!project) return settings;
  const next: AgenticChatSettings = {
    ...settings,
    approval: {
      ...settings.approval,
      workingDirs: [...project.folders],
    },
    web: { ...settings.web },
    mcp: { ...settings.mcp },
    systemPrompt: projectPrompt(settings.systemPrompt, project),
    outputStyle: project.profile ?? settings.outputStyle,
  };
  if (project.modelId) applyProjectModel(next, project.modelId);
  if (project.tools?.web !== undefined) next.web.enabled = project.tools.web;
  if (project.tools?.mcp !== undefined) next.mcp.enabled = project.tools.mcp;
  return next;
}

export function isPathInProjectScope(path: string, folders: readonly string[]): boolean {
  if (folders.length === 0) return true;
  let normalizedPath: string;
  try {
    normalizedPath = normalizeVaultPath(path);
  } catch {
    return false;
  }
  return folders.some((folder) => folder === "" || normalizedPath === folder || normalizedPath.startsWith(`${folder}/`));
}

export function projectLabel(project: AgentProject | undefined): string {
  return project?.name ?? "Vault-wide";
}

export function describeProject(project: AgentProject): string {
  const parts = [
    project.folders.length ? `folders: ${project.folders.map((folder) => folder || "/").join(", ")}` : "all notes",
    project.modelId ? `model: ${project.modelId}` : "",
    project.profile ? `profile: ${OUTPUT_STYLES[project.profile].label}` : "",
    project.tools?.web !== undefined ? `web: ${formatOnOff(project.tools.web)}` : "",
    project.tools?.mcp !== undefined ? `MCP: ${formatOnOff(project.tools.mcp)}` : "",
  ].filter(Boolean);
  return parts.join(" · ");
}

function projectPrompt(basePrompt: string, project: AgentProject): string {
  const lines = [
    basePrompt.trimEnd(),
    "",
    "## Active project workspace",
    `Project: ${project.name}`,
    project.folders.length ? `Scoped folders: ${project.folders.map((folder) => folder || "/").join(", ")}` : "",
    project.profile ? `Project profile: ${OUTPUT_STYLES[project.profile].label}` : "",
    project.systemPrompt ? `Project instructions: ${project.systemPrompt}` : "",
    "Use project scope as the default working context. Ask before crossing project boundaries.",
  ].filter(Boolean);
  return lines.join("\n");
}

function formatOnOff(value: boolean): string {
  return value ? "on" : "off";
}

function isClearProjectCommand(input: string): boolean {
  return ["clear", "none", "vault", "vault-wide"].includes(input.toLowerCase());
}

function findProject(projects: readonly AgentProject[], input: string): AgentProject | undefined {
  const needle = input.toLowerCase();
  return projects.find((project) => project.id.toLowerCase() === needle || project.name.toLowerCase() === needle);
}

function applyProjectModel(settings: AgenticChatSettings, modelId: string): void {
  if (settings.provider === "ollama") {
    settings.ollamaModel = modelId;
    return;
  }
  if (settings.provider === "openai-compatible") {
    settings.openaiCompatibleModel = modelId;
    return;
  }
  settings.openrouterModel = modelId;
}

function healProject(value: unknown): AgentProject | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const name = stringValue(input.name);
  const id = normalizeProjectId(stringValue(input.id) || name);
  if (!id) return null;
  const folders = normalizeFolders(input.folders);
  return {
    id,
    name: name || id,
    folders,
    modelId: stringValue(input.modelId),
    profile: outputStyle(input.profile),
    systemPrompt: stringValue(input.systemPrompt),
    tools: healToolSettings(input.tools),
  };
}

function normalizeProjectId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
}

function normalizeFolders(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    try {
      const normalized = normalizeFolderPath(item === "/" ? "" : item);
      if (!out.includes(normalized)) out.push(normalized);
    } catch {
      continue;
    }
  }
  return out;
}

function healToolSettings(value: unknown): ProjectToolSettings | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  const tools: ProjectToolSettings = {};
  if (typeof input.web === "boolean") tools.web = input.web;
  if (typeof input.mcp === "boolean") tools.mcp = input.mcp;
  return Object.keys(tools).length ? tools : undefined;
}

function outputStyle(value: unknown): OutputStyle | undefined {
  return typeof value === "string" && value in OUTPUT_STYLES ? (value as OutputStyle) : undefined;
}

function dedupeProjects(projects: AgentProject[]): AgentProject[] {
  const seen = new Map<string, number>();
  return projects.map((project) => {
    const count = seen.get(project.id) ?? 0;
    seen.set(project.id, count + 1);
    return count === 0 ? project : { ...project, id: `${project.id}-${count + 1}` };
  });
}

function isProject(value: AgentProject | null): value is AgentProject {
  return value !== null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
