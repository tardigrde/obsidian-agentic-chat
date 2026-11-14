import type { SettingDefinitionItem } from "obsidian";
import { row } from "./settings-definition-kit";
import type { AgenticChatSettings } from "./settings-schema";
import type { SettingsTabHost } from "./settings-tab-host";

export function ignoredFileDefinitions(settings: AgenticChatSettings, host: SettingsTabHost): SettingDefinitionItem[] {
  return [
    row("Ignore list", (setting) => {
      setting
        .setDesc(
          "One gitignore-style glob per line. Matching notes are invisible to the agent — it cannot read, " +
            "list, search, or edit them. Examples: Private/  ·  *.secret.md  ·  /Inbox/passwords.md  ·  **/diary/**",
        )
        .addTextArea((text) => {
          text.inputEl.rows = 6;
          text.inputEl.addClass("agentic-chat-system-prompt");
          text.setPlaceholder("Private/\n*.secret.md").setValue(settings.ignoredGlobs).onChange(async (value) => {
            settings.ignoredGlobs = value;
            await host.save();
          });
        });
    }),
  ];
}
