import { type App, type DataAdapter, TFolder } from "obsidian";
import { ensureVaultFolder, ensureVaultParentFolder } from "../vault/storage";
import type { PackageWriter } from "./import/install";
import { DEFAULT_PLUGINS_FOLDER, pluginMcpServerId } from "./loader";
import { slugifyPluginName } from "./manifest";

type StatAdapter = DataAdapter & {
  stat?: (target: string) => Promise<{ type: "file" | "folder" } | null>;
};

/**
 * Vault access confined to the Agent Plugins folder. Every write, rename, and
 * removal an install, sweep, or materialization performs goes through the
 * writer here, and the writer refuses to remove anything outside the folder.
 * It holds no state: the folder is read from settings on every call.
 */
export class PluginVault {
  constructor(
    readonly app: App,
    private readonly getFolderSetting: () => string,
  ) {}

  /** The configured plugins folder, or the default when the setting is unsafe. */
  folder(): string {
    const raw = this.getFolderSetting().trim().replace(/\/+$/, "");
    if (!raw) return DEFAULT_PLUGINS_FOLDER;
    if (raw.startsWith("/") || raw.includes(":") || raw.includes("\\")) return DEFAULT_PLUGINS_FOLDER;
    const segments = raw.split("/").filter(Boolean);
    if (segments.length === 0 || segments.some((segment) => segment === ".." || segment === ".")) {
      return DEFAULT_PLUGINS_FOLDER;
    }
    return raw;
  }

  /** True for a path strictly below the plugins folder, without traversal segments. */
  contains(target: string): boolean {
    if (!target || target === "/" || target.trim() === "") return false;
    const folder = this.folder().replace(/\/+$/, "");
    const normalized = target.trim().replace(/\/+$/, "");
    if (normalized === folder) return false;
    if (!normalized.startsWith(`${folder}/`)) return false;
    const suffix = normalized.slice(folder.length + 1);
    if (!suffix || suffix.split("/").some((segment) => segment === ".." || segment === "." || segment.length === 0)) return false;
    return true;
  }

  /** True for the plugins folder itself or any path inside it. */
  isAtOrBelow(path: string): boolean {
    const folder = this.folder().replace(/\/+$/, "");
    return path === folder || path.startsWith(`${folder}/`);
  }

  /** True when a vault file exists in the tree or on disk (stale-tree safe). */
  async fileExists(path: string): Promise<boolean> {
    if (this.app.vault.getAbstractFileByPath(path)) return true;
    try {
      await this.app.vault.adapter.read(path);
      return true;
    } catch {
      return false;
    }
  }

  /** On-disk kind at `path`: the tree may be stale, so stat decides existence. */
  async kindOf(path: string): Promise<"folder" | "file" | "missing"> {
    const adapter = this.app.vault.adapter as StatAdapter;
    if (typeof adapter.stat === "function") {
      try {
        const stat = await adapter.stat(path);
        if (!stat) return "missing";
        return stat.type === "folder" ? "folder" : "file";
      } catch {
        // stat failure is not proof of absence; fall through to exists.
      }
    }
    try {
      if (!(await adapter.exists(path))) return "missing";
    } catch {
      // Unknown state: report a file so callers keep what is there.
      return "file";
    }
    const entry = this.app.vault.getAbstractFileByPath(path);
    if (entry instanceof TFolder) return "folder";
    if (entry) return "file";
    try {
      await adapter.list(path);
      return "folder";
    } catch {
      return "file";
    }
  }

  /** First free package folder name for `seed`: `name`, then `name-2`, ... */
  nextAvailableName(seed: string): string {
    const base = slugifyPluginName(seed);
    const root = this.app.vault.getAbstractFileByPath(this.folder());
    const existing = new Set((root instanceof TFolder ? root.children : []).map((child) => child.name));
    if (!existing.has(base)) return base;
    for (let index = 2; index < 100; index += 1) {
      const candidate = `${base}-${index}`;
      if (!existing.has(candidate)) return candidate;
    }
    return `${base}-${Date.now()}`;
  }

  /** Best-effort read of the server ids a package declares in `mcp.json` (bounded). */
  async readMcpServerIds(name: string, rootPath: string): Promise<string[]> {
    try {
      const raw = await this.app.vault.adapter.read(`${rootPath}/mcp.json`);
      if (!raw || raw.length > 128 * 1024) return [];
      const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
      const mcpServers = parsed?.mcpServers;
      if (!mcpServers || typeof mcpServers !== "object") return [];
      // Bound iteration to avoid DOS from crafted huge mcp.json
      return Object.keys(mcpServers)
        .slice(0, 100)
        .map((key) => pluginMcpServerId(name, key));
    } catch {
      // Best-effort only; orphans are also pruned on the next reload.
      return [];
    }
  }

  /** The vault-backed writer every install, sweep, and materialization uses. */
  writer(): PackageWriter {
    const app = this.app;
    return {
      ensureFolder: async (path) => ensureVaultFolder(app, path),
      writeFile: async (path, content) => {
        await ensureVaultParentFolder(app, path);
        if (typeof content === "string") {
          await app.vault.create(path, content);
          return;
        }
        const text = decodeUtf8(content);
        // Text survives round-tripping; only binary files need the adapter.
        if (new TextEncoder().encode(text).every((byte, index) => byte === content[index])) {
          await app.vault.create(path, text);
        } else {
          const copy = new Uint8Array(content.length);
          copy.set(content);
          await app.vault.adapter.writeBinary(path, copy.buffer);
        }
      },
      removeFolder: async (path) => {
        if (!this.contains(path)) return false;
        const inTree = app.vault.getAbstractFileByPath(path) instanceof TFolder;
        const onDisk = await app.vault.adapter.exists(path).catch(() => false);
        if (!inTree && !onDisk) return false;
        try {
          await app.vault.adapter.rmdir(path, true);
        } catch (error) {
          const code = (error as { code?: string })?.code;
          const message = String((error as Error)?.message ?? "").toLowerCase();
          if (code === "ENOENT" || message.includes("enoent")) return false;
          throw error;
        }
        pruneTreeFolder(app, path);
        return true;
      },
      folderExists: async (path) => {
        const entry = app.vault.getAbstractFileByPath(path);
        if (entry) return entry instanceof TFolder;
        const adapter = app.vault.adapter as StatAdapter;
        if (typeof adapter.stat !== "function") return false;
        try {
          const stat = await adapter.stat(path);
          return stat?.type === "folder";
        } catch {
          return false;
        }
      },
      renameFolder: async (from, to) => {
        await app.vault.adapter.rename(from, to);
      },
    };
  }
}

/** Decode bytes as UTF-8 (imported manifests and docs are text). */
export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

/** Drop a folder from the vault file tree after an adapter-level removal. */
function pruneTreeFolder(app: App, path: string): void {
  const entry = app.vault.getAbstractFileByPath(path);
  if (!(entry instanceof TFolder)) return;
  const siblings = entry.parent?.children;
  if (!siblings) return;
  const index = siblings.indexOf(entry);
  if (index >= 0) siblings.splice(index, 1);
}
