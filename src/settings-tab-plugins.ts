import {
  ButtonComponent,
  Notice,
  TFile,
  TFolder,
  ToggleComponent,
  type SettingDefinitionItem,
  type SettingDefinitionRender,
} from "obsidian";
import { DEFAULT_PLUGINS_FOLDER, type LoadedPlugin } from "./plugins/loader";
import { block, headingRow, renderItemsInto, row } from "./settings-definition-kit";
import type { AgenticChatSettings } from "./settings-schema";
import { FolderSuggestModal } from "./ui/folder-suggest";
import { InstallPluginModal, noticeInstallResult } from "./ui/install-plugin-modal";
import { NewSkillModal } from "./ui/new-skill-modal";
import type { SettingsTabHost } from "./settings-tab-host";

export function pluginDefinitions(settings: AgenticChatSettings, host: SettingsTabHost): SettingDefinitionItem[] {
  const items: SettingDefinitionItem[] = [
    block((setting) => {
      setting.settingEl.createDiv({ cls: "setting-item-description" }).createSpan({
        text:
          "Plugins are packages in the vault that contribute skills and MCP servers. They follow the " +
          "Agent Plugins 1.0.0 specification and are the single source of truth for skills and MCP. " +
          "Skill precedence: plugin skills win over built-ins of the same name. " +
          "The my-skills package is your personal collection space for hand-curated custom skills.",
      });
    }),
    row("Import", (setting) => {
      setting
        .setClass("agentic-chat-plugins-import")
        .addButton((button) =>
          button
            .setButtonText("Install plugin…")
            .setCta()
            .onClick(() => openInstallModal(host)),
        )
        .addButton((button) =>
          button.setButtonText("New skill…").onClick(() => {
            new NewSkillModal(host.app, host.plugin.pluginService, (result) => {
              noticeInstallResult(result);
              host.invalidatePluginLoad();
              void host.save().then(() => host.redraw());
            }).open();
          }),
        )
        .addButton((button) =>
          button
            .setButtonText("Repair built-ins")
            .setDisabled(!builtinsPackageExists(settings, host))
            .onClick(async () => {
              await host.plugin.pluginService.repairBuiltins();
              new Notice("Built-in skill package recreated.");
              host.invalidatePluginLoad();
              await host.save();
              host.redraw();
            }),
        );
    }),
    row("Plugins folder", (setting) => {
      setting
        .setDesc("Vault folder scanned for agent plugin packages (plugin.json + skills/ + mcp.json).")
        .addText((text) => {
          text.setPlaceholder("(none)").setValue(settings.plugins.folder).onChange((next) => {
            void setPluginsFolder(settings, next.trim(), host);
          });
          text.inputEl.addClass("agentic-chat-folder-input");
        })
        .addButton((button) =>
          button.setButtonText("Browse").onClick(() => {
            new FolderSuggestModal(host.app, (folder) => {
              const path = folder.path === "/" ? "" : folder.path;
              void setPluginsFolder(settings, path, host);
            }).open();
          }),
        );
    }),
  ];
  items.push(...pluginListDefinitions(settings, host));
  return items;
}

export async function setPluginsFolder(
  settings: AgenticChatSettings,
  value: string,
  host: SettingsTabHost,
): Promise<void> {
  settings.plugins.folder = value;
  host.plugin.pluginService.invalidate();
  host.invalidatePluginLoad();
  await host.save();
  host.redraw();
}

export function pluginListDefinitions(settings: AgenticChatSettings, host: SettingsTabHost): SettingDefinitionItem[] {
  host.ensurePluginsLoaded();
  return [
    block(
      (setting) => {
        // Read the loaded packages at render time so a package installed or
        // deleted while the settings tab was closed is reflected on open.
        const plugins = host.plugin.pluginService.getLoaded();
        const deleted = host.externallyDeletedPlugins();
        if (plugins.length === 0 && deleted.length === 0) {
          setting.settingEl.createDiv({
            cls: "setting-item-description",
            text:
              "No agent plugins found. Use “Install plugin…” to bring one in from GitHub or an archive " +
              "(Claude/Copilot/VS Code packages are converted automatically), or “New skill…” to scaffold your own.",
          });
          return;
        }

        const items: SettingDefinitionItem[] = [];
        if (plugins.length > 0) {
          items.push(headingRow("Installed plugins"));
          for (const plugin of plugins) {
            items.push(pluginRowDefinition(settings, plugin, host));
          }
        }
        if (deleted.length > 0) {
          items.push(
            headingRow("Deleted on disk"),
            block((row) => {
              row.settingEl.createDiv({
                cls: "setting-item-description",
                text: "These plugins were deleted outside Obsidian. Settings were cleaned; dismiss this notice when ready.",
              });
            }),
          );
          for (const plugin of deleted) {
            items.push(deletedPluginRowDefinition(settings, plugin, host));
          }
          items.push(
            row("", (row) => {
              row.addButton((button) =>
                button.setButtonText("Dismiss").onClick(() => {
                  host.setExternallyDeletedPlugins([]);
                  host.redraw();
                }),
              );
            }),
          );
        }
        renderItemsInto(setting.settingEl, items);
      },
      { name: "Installed plugins", visible: true },
    ),
  ];
}

export function pluginRowDefinition(
  settings: AgenticChatSettings,
  plugin: LoadedPlugin,
  host: SettingsTabHost,
): SettingDefinitionRender {
  return row(plugin.name, (setting) => {
    setting.settingEl.empty();
    setting.settingEl.addClass("agentic-chat-plugin-row");

    const main = setting.settingEl.createDiv({ cls: "agentic-chat-plugin-main" });
    main.createDiv({ cls: "agentic-chat-plugin-name", text: plugin.name });

    const status = plugin.enabled ? plugin.auditStatus : "disabled";
    const typeCounts =
      `${plugin.skills.length} skill${plugin.skills.length === 1 ? "" : "s"}, ` +
      `${plugin.mcpServers.length} MCP server${plugin.mcpServers.length === 1 ? "" : "s"}`;
    const meta = main.createDiv({ cls: "agentic-chat-plugin-meta" });
    meta.createSpan({ text: `${plugin.rootPath} — ${status}, ${typeCounts}` });
    const extra: string[] = [];
    if (plugin.version) extra.push(`v${plugin.version}`);
    if (plugin.manifestProblem) extra.push(plugin.manifestProblem);
    if (plugin.reports.length > 0) extra.push(plugin.reports.map((report) => report.message).join("; "));
    const source = settings.plugins.sources?.[plugin.name];
    if (source) extra.push(`Source: ${source}`);
    if (extra.length > 0) {
      const tail = meta.createSpan({ cls: "agentic-chat-plugin-meta-extra" });
      tail.createSpan({ text: ` — ${extra.join(" · ")}` });
    }

    const controls = setting.settingEl.createDiv({ cls: "agentic-chat-plugin-controls" });
    new ToggleComponent(controls)
      .setValue(plugin.enabled)
      .setTooltip(`Enable ${plugin.name}`)
      .onChange(async (value) => {
        const enabled = { ...settings.plugins.enabled };
        if (value) delete enabled[plugin.name];
        else enabled[plugin.name] = false;
        settings.plugins.enabled = enabled;
        host.plugin.pluginService.invalidate();
        host.invalidatePluginLoad();
        await host.save();
        host.redraw();
      });
    new ButtonComponent(controls)
      .setButtonText("Open folder")
      .onClick(() => openInVault(host, plugin.rootPath));
    new ButtonComponent(controls)
      .setButtonText("Remove")
      .setDestructive()
      .onClick(async () => {
        const existed = await host.plugin.pluginService.removePackage(plugin.name, plugin.rootPath);
        if (existed) new Notice(`Removed agent plugin "${plugin.name}".`);
        else new Notice(`Agent plugin "${plugin.name}" was already deleted on disk — settings cleaned.`);
        host.invalidatePluginLoad();
        await host.save();
        host.redraw();
      });
  });
}

export function deletedPluginRowDefinition(
  settings: AgenticChatSettings,
  plugin: LoadedPlugin,
  host: SettingsTabHost,
): SettingDefinitionRender {
  return row(plugin.name, (setting) => {
    setting.settingEl.empty();
    setting.settingEl.addClass("agentic-chat-plugin-row", "agentic-chat-plugin-deleted");
    const main = setting.settingEl.createDiv({ cls: "agentic-chat-plugin-main" });
    main.createDiv({ cls: "agentic-chat-plugin-name", text: plugin.name });
    const meta = main.createDiv({ cls: "agentic-chat-plugin-meta" });
    meta.createSpan({ text: `${plugin.rootPath} — deleted on disk` });
    const source = settings.plugins.sources?.[plugin.name];
    if (source) {
      const tail = meta.createSpan({ cls: "agentic-chat-plugin-meta-extra" });
      tail.createSpan({ text: ` — Source: ${source}` });
    }
    const controls = setting.settingEl.createDiv({ cls: "agentic-chat-plugin-controls" });
    new ButtonComponent(controls)
      .setButtonText("Dismiss")
      .onClick(async () => {
        // Guard the TOCTOU: if the folder was recreated since the transient was shown, don't delete it.
        let shouldRemove: boolean;
        try {
          shouldRemove = !(await host.app.vault.adapter.exists(plugin.rootPath));
        } catch {
          shouldRemove = false;
        }
        if (shouldRemove) await host.plugin.pluginService.removePackage(plugin.name, plugin.rootPath);
        host.setExternallyDeletedPlugins(
          host.externallyDeletedPlugins().filter((entry) => entry.rootPath !== plugin.rootPath),
        );
        host.redraw();
      });
  });
}

export function openInstallModal(host: SettingsTabHost): void {
  new InstallPluginModal(host.app, host.plugin.pluginService, (result) => {
    noticeInstallResult(result);
    host.invalidatePluginLoad();
    void host.save().then(() => host.redraw());
  }).open();
}

export function builtinsPackageExists(settings: AgenticChatSettings, host: SettingsTabHost): boolean {
  const folder = settings.plugins.folder.trim() || DEFAULT_PLUGINS_FOLDER;
  const entry = host.app.vault.getAbstractFileByPath(`${folder}/builtins`);
  return entry instanceof TFolder;
}

export function openInVault(host: SettingsTabHost, path: string): void {
  const entry = host.app.vault.getAbstractFileByPath(path);
  if (!entry) {
    new Notice(`Agentic Chat: ${path} no longer exists.`);
    return;
  }
  const vault = host.app.vault as unknown as { open?: (path: string) => Promise<void> };
  if (entry instanceof TFolder) {
    // WorkspaceLeaf.openFile only accepts files; folders get revealed in
    // the File Explorer view when one exists.
    const fileExplorer = host.app.workspace.getLeavesOfType("file-explorer")[0];
    const view = fileExplorer?.view as { revealInFolder?: (folder: TFolder) => void } | undefined;
    if (fileExplorer && view?.revealInFolder) {
      void host.app.workspace.revealLeaf(fileExplorer);
      view.revealInFolder(entry);
      return;
    }
    if (vault.open) void vault.open(`/${path}`);
    return;
  }
  if (!(entry instanceof TFile)) return;
  const fileExplorer = host.app.workspace.getLeavesOfType("file-explorer")[0];
  if (fileExplorer) {
    void fileExplorer.openFile(entry);
    return;
  }
  if (vault.open) void vault.open(`/${path}`);
}
