import { App, Modal, Notice, Platform, Setting } from "obsidian";
import type { PluginService } from "../plugins/service";
import type { InstallResult } from "../plugins/import/install";
import { extractArchive, looksGzip, looksZip, safeArchivePath, type FileTree } from "../plugins/import/archive";
import { stripSingleTopLevelDir } from "../plugins/import/url-source";
import { sniffSource, type MarketplaceSourceEntry } from "../plugins/import/sniff";

/**
 * The Install plugin modal: install from a GitHub/archive URL, a vault folder
 * (desktop), or an archive file, plus marketplace catalogs offered as pick
 * lists. Re-importing a same-named plugin replaces it in place; imported MCP
 * servers start disabled.
 */
export class InstallPluginModal extends Modal {
  private readonly status = document.createElement("div");

  constructor(
    app: App,
    private readonly pluginService: PluginService,
    private readonly onInstalled: (result: InstallResult) => void,
    private readonly onError: (message: string) => void,
  ) {
    super(app);
    this.setTitle("Install agent plugin");
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    const warning = contentEl.createDiv({ cls: "setting-item-description" });
    warning.createSpan({
      text:
        "Plugins add skills and MCP servers that act with your vault and network access. " +
        "Only install packages from sources you trust. Imported MCP servers start disabled.",
    });

    this.renderSourceFields(contentEl);
    this.status.addClass("agentic-chat-install-status");
    contentEl.appendChild(this.status);
  }

  private renderSourceFields(containerEl: HTMLElement): void {
    let urlInput: HTMLInputElement | null = null;
    new Setting(containerEl)
      .setName("GitHub or archive URL")
      .setDesc(
        "Examples: owner/repo · https://github.com/owner/repo · /tree/<ref>/<folder> · " +
          "/blob/<ref>/<path>/SKILL.md · https://...zip | .tar.gz. Re-importing the same plugin updates it in place.",
      )
      .addText((text) => {
        urlInput = text.inputEl;
        urlInput.placeholder = "owner/repo or https://github.com/owner/repo";
        urlInput.addClass("agentic-chat-install-url");
        urlInput.addEventListener("keydown", (event) => {
          if (event.key === "Enter") void this.installFromUrl(urlInput?.value ?? "");
        });
      })
      .addButton((button) =>
        button
          .setButtonText("Install")
          .setCta()
          .onClick(() => void this.installFromUrl(urlInput?.value ?? "")),
      );

    containerEl.createDiv({ cls: "setting-item-description", text: "Pick a source:" }).addClass("agentic-chat-install-hint");

    const actions = new Setting(containerEl);
    actions.addButton((button) =>
      button.setButtonText("Vault folder…").setCta().onClick(() => this.pickFolder()).setDisabled(Platform.isMobile),
    );
    actions.addButton((button) => button.setButtonText("Archive file…").setCta().onClick(() => this.pickArchive()));
    if (Platform.isMobile) {
      actions.setDesc("Folder picking is desktop-only; URL and archive installs work everywhere.");
    }
  }

  private async installFromUrl(value: string): Promise<void> {
    const url = value.trim();
    if (!url) {
      this.setStatus("Enter a GitHub URL or owner/repo shorthand first.", "error");
      return;
    }
    this.setStatus(`Resolving ${url}…`, "working");
    try {
      const result = await this.pluginService.installFromSource(url);
      this.onInstalled(result);
      this.close();
    } catch (error) {
      this.setStatus(error instanceof Error ? error.message : String(error), "error");
      this.onError(error instanceof Error ? error.message : String(error));
    }
  }

  /** Desktop-only: webkitdirectory folder picker read into a tree, then sniff + install. */
  private pickFolder(): void {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.setAttribute("webkitdirectory", "");
    input.setAttribute("directory", "");
    input.accept = "";
    input.onchange = async () => {
      const entries = input.files ? Array.from(input.files) : [];
      if (entries.length === 0) return;
      this.setStatus(`Reading ${entries.length} files…`, "working");
      const tree: FileTree = new Map();
      for (const file of entries) {
        const relative = file.webkitRelativePath ?? file.name;
        // Normalize through the same guard used for archive paths so the
        // install pipeline never sees `.`/`..`/reserved segments.
        const safe = safeArchivePath(relative);
        if (!safe) continue;
        tree.set(safe, new Uint8Array(await file.arrayBuffer()));
      }
      await this.installTree(tree, "Local folder");
    };
    input.click();
  }

  /** Archive file picker: extract in-memory, then sniff + install. */
  private pickArchive(): void {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".zip,.tar.gz,.tgz";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      this.setStatus(`Extracting ${file.name}…`, "working");
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const kind = looksZip(bytes) ? "zip" : looksGzip(bytes) ? "tar.gz" : null;
        if (!kind) {
          this.setStatus(`${file.name} is not a ZIP or tar.gz archive.`, "error");
          return;
        }
        const tree = stripSingleTopLevelDir(extractArchive(bytes, kind));
        await this.installTree(tree, file.name);
      } catch (error) {
        this.setStatus(error instanceof Error ? error.message : String(error), "error");
      }
    };
    input.click();
  }

  /** Sniff the tree; offer marketplace picks when the source is a catalog. */
  private async installTree(tree: FileTree, label: string): Promise<void> {
    const sniffed = sniffSource(tree);
    if (sniffed.kind === "marketplace") {
      this.renderMarketplace(tree, sniffed.name, sniffed.sources);
      return;
    }
    try {
      const result = await this.pluginService.installFromTree(tree, label);
      this.onInstalled(result);
      this.close();
    } catch (error) {
      this.setStatus(error instanceof Error ? error.message : String(error), "error");
      this.onError(error instanceof Error ? error.message : String(error));
    }
  }

  /** Show `./`-relative catalog entries as an install pick list. */
  private renderMarketplace(tree: FileTree, name: string, sources: MarketplaceSourceEntry[]): void {
    this.status.empty();
    const header = this.contentEl.createDiv({ cls: "setting-item-description" });
    header.createSpan({
      text:
        `Marketplace "${name}". Only catalog entries pointing at folders inside this source can be ` +
        "installed directly; git/npm/archive sources are listed but not fetched.",
    });

    for (const entry of sources) {
      if (entry.kind === "local" && entry.folder) {
        const folder = entry.folder;
        new Setting(this.contentEl)
          .setName(entry.name)
          .setDesc(`./${folder}`)
          .addButton((button) =>
            button.setButtonText("Install").setCta().onClick(() => {
              const subtree: FileTree = new Map();
              for (const [path, bytes] of tree) {
                if (path === folder) continue;
                if (path.startsWith(`${folder}/`)) subtree.set(path.slice(folder.length + 1), bytes);
              }
              void this.installTree(subtree, `marketplace:${name}/${folder}`);
            }),
          );
      } else {
        new Setting(this.contentEl)
          .setName(entry.name)
          .setDesc(`Not auto-installable from a marketplace catalog: ${entry.source ?? "(no source)"}`);
      }
    }
  }

  private setStatus(message: string, kind: "working" | "error"): void {
    this.status.empty();
    this.status.createSpan({ text: message });
    this.status.className = `agentic-chat-install-status is-${kind}`;
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Report an install to the user and close the modal. */
export function noticeInstallResult(result: InstallResult): void {
  const parts = [
    `${result.updated ? "Updated" : "Installed"} plugin "${result.name}"`,
    `${result.skills} skill${result.skills === 1 ? "" : "s"}`,
    `${result.mcpServers} MCP server${result.mcpServers === 1 ? "" : "s"}`,
    `${result.files} files`,
  ];
  new Notice(`${parts.join(" · ")}${result.warnings.length > 0 ? " · see Resources tab for reports" : ""}`, 6000);
}