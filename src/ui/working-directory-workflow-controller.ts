import type { Menu } from "obsidian";
import { normalizeFolderPath } from "../vault/path";
import type { WorkflowRenderer } from "./workflow-renderer";

export interface WorkingDirectoryWorkflowControllerOptions {
  workingDirs: () => string[];
  folderExists: (path: string) => boolean;
  activeFolder?: () => string | null | undefined;
  vaultBasePath?: () => string | null | undefined;
  saveSettings: () => Promise<void>;
  afterChange: () => void;
  pickWorkingDir: () => void;
  pickFolderAttachment: () => void;
  renderer: WorkflowRenderer;
}

export class WorkingDirectoryWorkflowController {
  constructor(private readonly options: WorkingDirectoryWorkflowControllerOptions) {}

  showFolderMenu(): void {
    this.options.renderer.clear();
    this.options.renderer.actionList(
      "Folders",
      "Grant a working directory (auto-run inside, ask outside) or attach a folder listing as one-off context.",
      [
        {
          label: "Add working directory...",
          detail: "Auto-run reads/writes inside it; ask before anything outside.",
          icon: "folder-check",
          onClick: () => this.options.pickWorkingDir(),
        },
        {
          label: "Attach folder listing...",
          detail: "Add a folder's file list to your next message as context.",
          icon: "folder",
          onClick: () => this.options.pickFolderAttachment(),
        },
      ],
    );
  }

  /**
   * Populate an Obsidian Menu (popover) with the same two folder actions, so the
   * folder pill can surface them as a dropdown anchored at the button instead of
   * as a chat action card. Titles lead with the benefit for discoverability.
   */
  attachFolderMenuItems(menu: Menu): void {
    menu.addItem((item) =>
      item
        .setTitle("Add working directory")
        .setIcon("folder-check")
        .onClick(() => this.options.pickWorkingDir()),
    );
    menu.addItem((item) =>
      item
        .setTitle("Attach folder listing")
        .setIcon("folder")
        .onClick(() => this.options.pickFolderAttachment()),
    );
  }

  showWorkingDirs(): void {
    this.options.renderer.clear();
    const dirs = this.options.workingDirs();
    this.options.renderer.actionList(
      "Working directories",
      formatDirectoryListSubtitle(dirs.length),
      [
        {
          label: "Add working directory...",
          detail: "Grant a folder as a working set.",
          icon: "folder-plus",
          onClick: () => this.options.pickWorkingDir(),
        },
        ...dirs.map((dir) => ({
          label: formatWorkingDirLabel(dir),
          detail: "Granted - click to revoke.",
          icon: "folder-check",
          onClick: () => void this.remove(dir),
        })),
      ],
    );
  }

  async runAddDir(arg: string): Promise<void> {
    this.options.renderer.clear();
    if (!arg) {
      this.options.pickWorkingDir();
      return;
    }
    await this.add(arg);
  }

  async add(path: string): Promise<void> {
    const resolved = this.resolveInput(path);
    if (resolved === null) return;

    const normalized = resolved.path;
    if (normalized !== "" && !this.options.folderExists(normalized)) {
      this.options.renderer.error(`"${normalized}" is not a folder in this vault.`);
      return;
    }
    const dirs = this.options.workingDirs();
    if (dirs.includes(normalized)) {
      this.options.renderer.info("Working directory", [[formatWorkingDirLabel(normalized), "Already a working directory."]]);
      return;
    }
    dirs.push(normalized);
    await this.options.saveSettings();
    this.options.afterChange();
    this.options.renderer.info("Working directory", [
      [
        formatWorkingDirLabel(normalized),
        "Granted - the agent auto-runs inside it and asks before touching anything outside.",
      ],
    ]);
  }

  async remove(dir: string): Promise<void> {
    const dirs = this.options.workingDirs();
    const index = dirs.indexOf(dir);
    if (index === -1) return;
    dirs.splice(index, 1);
    await this.options.saveSettings();
    this.options.afterChange();
  }

  private resolveInput(path: string): { path: string } | null {
    const resolved = resolveWorkingDirectoryInput(path, {
      activeFolder: this.options.activeFolder?.() ?? "",
      vaultBasePath: this.options.vaultBasePath?.() ?? null,
    });
    if ("error" in resolved) {
      this.options.renderer.error(resolved.error);
      return null;
    }
    return resolved;
  }
}

export function formatWorkingDirLabel(dir: string): string {
  return dir === "" ? "/ (vault root)" : dir;
}

function formatDirectoryListSubtitle(workingDirCount: number): string {
  if (workingDirCount > 0) return "Auto-run inside these; ask before touching anything outside.";
  return "None granted - reads/writes follow your approval policy everywhere in the vault.";
}

export interface WorkingDirectoryPathContext {
  /** Vault-relative folder used as the base for shell-style `./` and `../` input. */
  activeFolder?: string | null;
  /** Desktop filesystem path to the vault root, when Obsidian exposes it. */
  vaultBasePath?: string | null;
}

export type ResolvedWorkingDirectoryInput = { path: string } | { error: string };

export function resolveWorkingDirectoryInput(
  input: string,
  context: WorkingDirectoryPathContext = {},
): ResolvedWorkingDirectoryInput {
  const raw = input.trim();
  if (!raw || raw === "/") return { path: "" };

  if (isAbsoluteFilesystemPath(raw)) {
    return resolveAbsoluteFolderInput(raw, context.vaultBasePath);
  }

  const base = isActiveFolderRelative(raw) ? context.activeFolder ?? "" : "";
  const resolved = resolveVaultFolderSegments(raw, base);
  if (resolved === null) {
    return { error: `Folder path "${input}" points outside this vault.` };
  }
  return normalizeResolvedVaultFolder(resolved, input);
}

function resolveAbsoluteFolderInput(input: string, vaultBasePath: string | null | undefined): ResolvedWorkingDirectoryInput {
  if (!vaultBasePath) {
    return { error: `Absolute folder path "${input}" cannot be resolved in this vault.` };
  }

  const relative = relativePathInsideBase(input, vaultBasePath);
  if (relative === null) {
    return {
      error: `Folder path "${input}" is outside this vault. Working directories must be inside "${displayFsPath(vaultBasePath)}".`,
    };
  }
  return normalizeResolvedVaultFolder(relative, input);
}

function normalizeResolvedVaultFolder(path: string, original: string): ResolvedWorkingDirectoryInput {
  try {
    return { path: normalizeFolderPath(path) };
  } catch {
    return { error: `Invalid folder path "${original}".` };
  }
}

function resolveVaultFolderSegments(input: string, baseFolder: string): string | null {
  const segments = pathSegments(baseFolder);
  for (const segment of input.replaceAll("\\", "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

function pathSegments(path: string | null | undefined): string[] {
  return (path ?? "")
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment && segment !== ".");
}

function isActiveFolderRelative(path: string): boolean {
  return path === "." || path === ".." || path.startsWith("./") || path.startsWith("../");
}

function isAbsoluteFilesystemPath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

function relativePathInsideBase(path: string, basePath: string): string | null {
  const absolute = normalizeFilesystemPath(path);
  const base = normalizeFilesystemPath(basePath);
  const caseInsensitive = /^[A-Za-z]:\//.test(absolute) || /^[A-Za-z]:\//.test(base);
  const comparableAbsolute = caseInsensitive ? absolute.toLowerCase() : absolute;
  const comparableBase = caseInsensitive ? base.toLowerCase() : base;

  if (comparableAbsolute === comparableBase) return "";
  if (!comparableAbsolute.startsWith(`${comparableBase}/`)) return null;
  return absolute.slice(base.length + 1);
}

function normalizeFilesystemPath(path: string): string {
  let normalized = path.trim().replaceAll("\\", "/").replace(/\/+/g, "/");
  while (normalized.length > 1 && normalized.endsWith("/") && !/^[A-Za-z]:\/$/.test(normalized)) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function displayFsPath(path: string): string {
  return normalizeFilesystemPath(path);
}
