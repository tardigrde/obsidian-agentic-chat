import { App, Modal, Notice, Setting } from "obsidian";
import type { PluginService } from "../plugins/service";
import type { InstallResult } from "../plugins/import/install";
import { slugifyPluginName } from "../plugins/manifest";

const SKILL_TEMPLATE = `# {{name}}

Describe what this skill does and when to consult it.

## Steps

1. First step.
2. Second step.

## Constraints

- Stay within the user's question.
- Do not invent facts; verify before claiming.`;

/**
 * The New skill wizard: scaffold a single-skill Agent Plugins package with a
 * spec-valid plugin.json and a SKILL.md template, ready for editing.
 */
export class NewSkillModal extends Modal {
  constructor(
    app: App,
    private readonly pluginService: PluginService,
    private readonly onInstalled: (result: InstallResult) => void,
  ) {
    super(app);
    this.setTitle("New skill");
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    let nameInput: HTMLInputElement | null = null;
    let descriptionInput: HTMLInputElement | null = null;
    let bodyInput: HTMLTextAreaElement | null = null;
    let bodyTouched = false;

    new Setting(contentEl)
      .setName("Skill name")
      .setDesc("Lowercase id; the skill folder and frontmatter name will use it.")
      .addText((text) => {
        nameInput = text.inputEl;
        text.setPlaceholder("e.g. release-notes");
        text.inputEl.addEventListener("input", () => {
          // Keep the template heading in sync while the user renames before
          // they have edited the body; once the body is touched, never clobber it.
          const slug = slugifyPluginName(nameInput?.value ?? "");
          if (bodyInput && !bodyTouched) {
            bodyInput.value = SKILL_TEMPLATE.replace("{{name}}", slug || "my-skill");
          }
        });
      });
    new Setting(contentEl)
      .setName("Description")
      .setDesc("One line: what the skill does and when to use it.")
      .addText((text) => {
        descriptionInput = text.inputEl;
      });
    new Setting(contentEl)
      .setName("Skill body")
      .setDesc("Markdown instructions the agent reads when the skill applies (frontmatter is managed for you).")
      .addTextArea((text) => {
        bodyInput = text.inputEl;
        bodyInput.rows = 14;
        bodyInput.addClass("agentic-chat-skill-body");
        text.setValue(SKILL_TEMPLATE.replace("{{name}}", "my-skill"));
        bodyInput.addEventListener("input", () => {
          bodyTouched = true;
        });
      });

    new Setting(contentEl).addButton((button) => {
      button.setButtonText("Create skill").setCta().onClick(async () => {
        const name = (nameInput?.value ?? "").trim();
        if (!name) {
          new Notice("Give the skill a name first.");
          return;
        }
        const description = (descriptionInput?.value ?? "").trim();
        const body = (bodyInput?.value ?? SKILL_TEMPLATE).trim();
        try {
          const existing = await this.pluginService.packageExists(slugifyPluginName(name));
          if (existing && !confirm(`A plugin named "${slugifyPluginName(name)}" already exists. Replace it with this new skill package?`)) {
            return;
          }
          // The user confirmed via the dialog above, so opt into overwrite explicitly.
          const result = await this.pluginService.scaffoldSkill({ name, description, body }, { allowOverwrite: true });
          this.onInstalled(result);
          this.close();
        } catch (error) {
          new Notice(error instanceof Error ? error.message : String(error));
        }
      });
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}