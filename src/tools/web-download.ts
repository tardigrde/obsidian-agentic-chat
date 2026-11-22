import type { App } from "obsidian";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { findVaultEntry } from "../vault/path-lookup";
import { ensureVaultParentFolder } from "../vault/storage";
import type { IgnoreMatcher } from "../vault/ignore";
import { normalizeVisibleVaultPath } from "./vault/shared";
import { toolResult } from "./result";
import { isHostAllowedByAllowlist } from "./web-allowlist";
import { normalizeWebUrl, type WebBinaryFetcher } from "./web-fetch";

/** Largest file `download_file` will save. A larger one is refused before any write. */
export const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

/**
 * File types the agent may save. Documents and images the rest of the plugin can
 * read (`import_document`, image attachments) and plain data files. No scripts,
 * no archives that unpack on their own, no HTML.
 */
export const DOWNLOAD_EXTENSIONS: ReadonlySet<string> = new Set([
  "pdf", "epub", "docx", "pptx", "xlsx", "csv", "txt", "json", "png", "jpg", "jpeg", "gif", "webp",
]);

const DownloadParameters = Type.Object({
  url: Type.String({ description: "http(s) URL" }),
  path: Type.String({ description: "vault-relative file path" }),
});

export interface WebDownloadConfig {
  app: App;
  isIgnored: IgnoreMatcher;
  fetcher: WebBinaryFetcher;
  /** Comma-separated host suffix allowlist; empty allows all public hosts. */
  allowedHosts?: string;
  maxBytes?: number;
  /** Vault folders the tool never writes into (the user's plugins folder: a downloaded plugin.json must not plant a package). */
  blockedFolders?: readonly string[];
}

/**
 * The `download_file` tool: save a binary file from the web into the vault. It
 * writes, so it is a mutating tool (it asks in Safe mode), and it is only
 * registered when web access is on. It never overwrites, never writes into a
 * dot-folder (`.obsidian`, `.agentic-plugins`) or the configured plugins folder (a
 * prompt-injected download must not plant a plugin or a skill), and refuses a web
 * page where a file was expected.
 *
 * Known limits, shared with `fetch_url`: Obsidian's `requestUrl` follows redirects
 * itself, so only the first URL is checked against the allowlist and the
 * private-address gate; and it returns the whole body, so the size cap is checked
 * after the bytes are in memory (a missing Content-Length cannot stop a huge body
 * from being buffered first).
 */
export function createWebDownloadTool(config: WebDownloadConfig): AgentTool<typeof DownloadParameters> {
  const maxBytes = config.maxBytes ?? MAX_DOWNLOAD_BYTES;
  return {
    name: "download_file",
    label: "Download file",
    description:
      `Save a file (pdf, epub, docx, pptx, xlsx, csv, txt, json, image) from a URL into the vault. Max ${Math.round(maxBytes / (1024 * 1024))} MB, never overwrites. ` +
      "Then import_document reads PDF/Office files.",
    parameters: DownloadParameters,
    executionMode: "sequential",
    execute: async (_id, params, signal) => {
      const url = normalizeWebUrl(params.url);
      const host = new URL(url).hostname;
      if (!isHostAllowedByAllowlist(host, config.allowedHosts ?? "")) throw new Error(`Blocked by allowlist: ${host}`);

      const path = normalizeVisibleVaultPath(config.isIgnored, params.path);
      assertSavablePath(path, config.blockedFolders);
      await assertFree(config.app, path);

      if (signal?.aborted) throw new Error("Aborted.");
      const response = await config.fetcher({ url, method: "GET" }, signal);
      if (signal?.aborted) throw new Error("Aborted.");
      if (response.status === 0) throw new Error(`Could not download ${url}: ${response.errorText || "network error"}.`);
      if (response.status < 200 || response.status >= 300) throw new Error(`Could not download ${url} (HTTP ${response.status}).`);

      const contentType = (response.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
      if (contentType === "text/html" || contentType === "application/xhtml+xml") {
        throw new Error(`${url} returned a web page, not a file. Use fetch_url to read a page, or find the direct link to the file.`);
      }
      const declared = Number(response.headers["content-length"]);
      if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge(url, declared, maxBytes);
      const size = response.bytes.byteLength;
      if (size > maxBytes) throw tooLarge(url, size, maxBytes);
      if (size === 0) throw new Error(`${url} returned an empty body.`);

      // Checked again: the request took time, and a sync client may have created it meanwhile.
      await assertFree(config.app, path);
      await ensureVaultParentFolder(config.app, path);
      await config.app.vault.createBinary(path, response.bytes);
      const hint = /\.(pdf|epub|docx|pptx|xlsx)$/i.test(path) ? ` Use import_document on "${path}" to read it.` : "";
      // The server controls the Content-Type text; echo only a plain media type.
      const shownType = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(contentType) ? contentType : "unknown type";
      return toolResult(`Downloaded ${size.toLocaleString("en-US")} bytes (${shownType}) from ${url} to ${path}.${hint}`, {
        url,
        path,
        bytes: size,
        contentType: shownType,
      });
    },
  };
}

function tooLarge(url: string, size: number, max: number): Error {
  const mb = (value: number) => (value / (1024 * 1024)).toFixed(1);
  return new Error(`${url} is ${mb(size)} MB; download_file saves at most ${mb(max)} MB.`);
}

/** The path must be a plain file path in a normal folder, with an allowed extension. */
async function assertFree(app: App, path: string): Promise<void> {
  // Exact and Unicode-normalized lookups, then the disk itself: a case-insensitive or
  // not-yet-indexed file must not be replaced.
  const taken = findVaultEntry(app, path) || (await app.vault.adapter.exists(path));
  if (taken) throw new Error(`${path} already exists. Choose another path; download_file never overwrites.`);
}

export function assertSavablePath(path: string, blockedFolders: readonly string[] = []): void {
  for (const folder of blockedFolders) {
    const root = folder.replace(/^\/+|\/+$/g, "");
    if (root && (path === root || path.startsWith(`${root}/`))) {
      throw new Error(`download_file does not write into the plugins folder (${root}).`);
    }
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment.startsWith("."))) {
    throw new Error(`download_file does not write into hidden folders or dot-files: ${path}`);
  }
  const name = segments[segments.length - 1] ?? "";
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  if (!DOWNLOAD_EXTENSIONS.has(extension)) {
    throw new Error(`download_file saves only ${[...DOWNLOAD_EXTENSIONS].join(", ")} files; "${name}" is not one of them.`);
  }
}
