import type { SettingDefinitionItem } from "obsidian";
import { row } from "./settings-definition-kit";
import type { AgenticChatSettings } from "./settings-schema";
import type { SettingsTabHost } from "./settings-tab-host";

export function ignoredFileDefinitions(settings: AgenticChatSettings, host: SettingsTabHost): SettingDefinitionItem[] {
  return [
    row("Ignored paths", (setting) => {
      setting
        .setDesc(
          "Private rules, separated by commas or new lines. A path glob or name (Private/, *.secret.md, private), " +
            "a tag (#private, nested tags too), or a property (private=true; private= for any value). " +
            "The agent cannot read, list, search, or change matching notes, and is told they are private. " +
            "A private active note is never sent.",
        )
        .addTextArea((text) => {
          text.inputEl.rows = 6;
          text.inputEl.addClass("agentic-chat-system-prompt");
          text.setPlaceholder("Private/, *.secret.md, #private, private=true").setValue(settings.ignoredGlobs).onChange(async (value) => {
            settings.ignoredGlobs = value;
            await host.save();
          });
        });
    }),
  ];
}
