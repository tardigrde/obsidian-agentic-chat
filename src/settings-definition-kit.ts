import {
  Setting,
  type SettingControl,
  type SettingDefinitionControl,
  type SettingDefinitionItem,
  type SettingDefinitionRender,
  type SettingGroup,
} from "obsidian";

/** Row builders shared by the settings tab and its section modules. */

/** A declarative row. Use render only when the control needs a side effect a plain control cannot express. */
export function row(
  name: string,
  render: (setting: Setting, group: SettingGroup) => void,
  extra: Omit<SettingDefinitionRender, "name" | "render"> = {},
): SettingDefinitionRender {
  return { name, render, ...extra };
}

export function headingRow(name: string): SettingDefinitionRender {
  return row(name, (setting) => {
    setting.setHeading();
  });
}

/** An inline text or warning block that is not a normal setting row. */
export function block(
  render: (setting: Setting) => void,
  options: { name?: string; visible?: boolean | (() => boolean) } = {},
): SettingDefinitionRender {
  return {
    name: options.name ?? "",
    searchable: false,
    visible: options.visible,
    render: (setting) => {
      setting.settingEl.empty();
      // A block is a plain container, not a row: nested dynamic rows must not
      // inherit the row padding/border of this wrapper.
      setting.settingEl.removeClass("setting-item");
      setting.settingEl.addClass("agentic-chat-settings-block");
      render(setting);
    },
  };
}

export function controlDef(
  name: string,
  control: SettingControl,
  desc?: string,
  extra: Omit<SettingDefinitionControl, "name" | "desc" | "control"> = {},
): SettingDefinitionControl {
  return { name, desc, control, ...extra };
}

/**
 * Render already-built row definitions into a live container. Used by
 * dynamic lists (MCP servers) that must read the current settings on every
 * render instead of freezing the collection at tab-build time.
 */
export function renderItemsInto(containerEl: HTMLElement, items: SettingDefinitionItem[]): void {
  for (const item of items) {
    if ("type" in item) continue;
    const def = item as SettingDefinitionRender;
    const visible = typeof def.visible === "function" ? def.visible() : def.visible;
    if (visible === false) continue;
    const setting = new Setting(containerEl);
    setting.setName(def.name ?? "").setDesc(typeof def.desc === "string" ? def.desc : "");
    if (def.render) def.render(setting, {} as SettingGroup);
  }
}

export function warning(icon: string, text: string): SettingDefinitionRender {
  return block((setting) => {
    const warning = setting.settingEl.createDiv({ cls: "agentic-chat-settings-warning" });
    warning.createSpan({ cls: "agentic-chat-settings-warning-icon", text: icon });
    warning.createSpan({ text });
  });
}

/** Explain how secrets are persisted for provider and tool credentials. */
export function apiKeyWarning(): SettingDefinitionRender {
  return warning(
    "i",
    "API keys and OAuth tokens are stored with Obsidian secret storage. The vault data.json stores " +
      "only secret IDs, not the secret values.",
  );
}

export function secretInputDef(options: {
  name: string;
  desc: string;
  placeholder: string;
  hasValue: () => boolean;
  onSet: (value: string) => Promise<void>;
  onForget: () => Promise<void>;
}, redraw: () => void): SettingDefinitionRender {
  return row(options.name, (setting) => {
    const status = options.hasValue()
      ? "A value is stored with Obsidian secret storage. Enter a new value to replace it."
      : "No value is stored yet.";
    setting.setDesc(`${options.desc} ${status}`).addText((text) => {
      text.inputEl.type = "password";
      text.setPlaceholder(options.placeholder).setValue("").onChange(async (value) => {
        const trimmed = value.trim();
        if (!trimmed) return;
        await options.onSet(trimmed);
      });
    });
    setting.addButton((button) =>
      button
        .setButtonText("Forget")
        .setDisabled(!options.hasValue())
        .onClick(async () => {
          button.setDisabled(true);
          await options.onForget();
          redraw();
        }),
    );
  });
}

export async function copyToClipboard(value: string): Promise<boolean> {
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (!clipboard?.writeText) return false;
  try {
    await clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}
