import { describe, expect, it, vi } from "vitest";
import type { App, Setting, SettingDefinitionRender, SettingGroup } from "obsidian";
import type { AgentMode } from "../src/agent/modes";
import { DEFAULT_SETTINGS, type AgenticChatSettings } from "../src/settings-schema";
import type { SettingsTabHost } from "../src/settings-tab-host";
import { agentDefinitions } from "../src/settings-tab-agent";

/**
 * The vitest Obsidian mock's Setting has no methods, so the Permission mode row
 * renders against these local fakes: just enough of Setting + DropdownComponent
 * to prove the value follows a mode change and stops after the row cleanup.
 */
class FakeDropdown {
  value: string | undefined;
  private changeHandler: ((value: string) => void | Promise<void>) | undefined;

  addOption(_value: string, _label: string): this {
    return this;
  }

  setValue(value: string): this {
    this.value = value;
    return this;
  }

  onChange(handler: (value: string) => void | Promise<void>): this {
    this.changeHandler = handler;
    return this;
  }

  async change(value: string): Promise<void> {
    await this.changeHandler?.(value);
  }
}

class FakeSetting {
  readonly dropdown = new FakeDropdown();

  setDesc(): this {
    return this;
  }

  addDropdown(callback: (dropdown: FakeDropdown) => void): this {
    callback(this.dropdown);
    return this;
  }
}

interface PermissionModeHarness {
  setting: FakeSetting;
  cleanup: (() => void) | undefined;
  broadcast: (mode: AgentMode) => void;
  requestModeChange: ReturnType<typeof vi.fn>;
}

function permissionModeHarness(settings: AgenticChatSettings): PermissionModeHarness {
  const listeners = new Set<(mode: AgentMode) => void>();
  const requestModeChange = vi.fn(async () => true);
  const plugin = {
    settings,
    onModeChange(listener: (mode: AgentMode) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    requestModeChange,
  };
  const host = {
    app: {} as App,
    plugin,
    save: async () => undefined,
  } as unknown as SettingsTabHost;
  const definition = agentDefinitions(settings, host)[0] as SettingDefinitionRender;
  const setting = new FakeSetting();
  const rendered = definition.render(setting as unknown as Setting, {} as SettingGroup);
  return {
    setting,
    cleanup: typeof rendered === "function" ? rendered : undefined,
    requestModeChange,
    broadcast: (mode) => {
      for (const listener of [...listeners]) listener(mode);
    },
  };
}

describe("Permission mode settings row sync", () => {
  it("updates the dropdown when the mode changes outside the settings tab", () => {
    const settings = { ...DEFAULT_SETTINGS, mode: "safe" as AgentMode };
    const { setting, broadcast } = permissionModeHarness(settings);
    expect(setting.dropdown.value).toBe("safe");

    settings.mode = "yolo";
    broadcast("yolo");

    expect(setting.dropdown.value).toBe("yolo");
  });

  it("stops following mode changes after the row cleanup runs", () => {
    const settings = { ...DEFAULT_SETTINGS, mode: "safe" as AgentMode };
    const { setting, cleanup, broadcast } = permissionModeHarness(settings);
    settings.mode = "yolo";
    broadcast("yolo");
    expect(setting.dropdown.value).toBe("yolo");

    cleanup?.();
    settings.mode = "safe";
    broadcast("safe");

    expect(setting.dropdown.value).toBe("yolo");
  });

  it("still routes a dropdown change through the plugin and re-syncs the persisted value", async () => {
    const settings = { ...DEFAULT_SETTINGS, mode: "safe" as AgentMode };
    const { setting, requestModeChange } = permissionModeHarness(settings);

    await setting.dropdown.change("yolo");

    expect(requestModeChange).toHaveBeenCalledWith("yolo");
    expect(setting.dropdown.value).toBe("safe");
  });
});
