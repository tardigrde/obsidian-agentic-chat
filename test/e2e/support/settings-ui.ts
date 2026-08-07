import { $, browser } from "@wdio/globals";

const PLUGIN_ID = "agentic-chat";

// Obsidian 1.13+ opens Settings in a separate popout window while the chat view
// stays in the main window. The DOM helpers below must query the popout, and
// app-level reads (executeObsidian) must run from the main window, so keep both
// handles and switch as needed.
let mainWindowId: string | undefined;
let settingsWindowId: string | undefined;

async function focusMainWindow(): Promise<void> {
  if (mainWindowId && (await browser.getWindowHandles()).includes(mainWindowId)) {
    await browser.switchToWindow(mainWindowId);
  }
}

async function focusSettingsWindow(): Promise<void> {
  if (settingsWindowId) await browser.switchToWindow(settingsWindowId);
}

/** Run an app-level (Obsidian API) callback from the main window. */
async function fromMainWindow<T>(fn: () => Promise<T>): Promise<T> {
  await focusMainWindow();
  try {
    return await fn();
  } finally {
    if (settingsWindowId) await focusSettingsWindow();
  }
}

export async function openAgenticChatSettings(): Promise<void> {
  mainWindowId = await browser.getWindowHandle();
  const opened = await browser.executeObsidian(async ({ app }, pluginId) => {
    const settings = (app as unknown as {
      setting?: {
        open?: () => void;
        openTabById?: (id: string) => void;
      };
    }).setting;
    if (!settings?.open || !settings.openTabById) return false;
    settings.open();
    settings.openTabById(pluginId);
    return true;
  }, PLUGIN_ID);

  if (!opened) {
    await browser.executeObsidianCommand("app:open-settings");
    await browser.execute((pluginName) => {
      const navItems = Array.from(document.querySelectorAll<HTMLElement>(".vertical-tab-nav-item"));
      const item = navItems.find((candidate) => candidate.innerText.trim() === pluginName);
      if (!item) throw new Error(`${pluginName} settings nav item not found`);
      item.click();
    }, "Agentic Chat");
  }

  // Follow the settings into its popout window on Obsidian 1.13+.
  const handles = await browser.getWindowHandles();
  settingsWindowId = handles.find((handle) => handle !== mainWindowId) ?? mainWindowId;
  await focusSettingsWindow();

  await $(".agentic-chat-settings-tabs").waitForExist();
}

export async function closeAgenticChatSettings(): Promise<void> {
  await focusSettingsWindow();
  await browser.execute(() => {
    for (const close of Array.from(document.querySelectorAll<HTMLElement>(".modal-close-button"))) close.click();
    for (const backdrop of Array.from(document.querySelectorAll<HTMLElement>(".modal-bg"))) backdrop.click();
  });
  settingsWindowId = undefined;
  await focusMainWindow();
}

export async function selectSettingsTab(label: string): Promise<void> {
  await focusSettingsWindow();
  await browser.execute((tabLabel) => {
    const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>(".agentic-chat-settings-tab"));
    const tab = tabs.find((candidate) => candidate.innerText.trim() === tabLabel);
    if (!tab) throw new Error(`Settings tab "${tabLabel}" not found`);
    tab.click();
  }, label);

  await browser.waitUntil(
    async () =>
      await browser.execute((tabLabel) => {
        const active = document.querySelector<HTMLElement>(".agentic-chat-settings-tab.is-active");
        return active?.innerText.trim() === tabLabel;
      }, label),
    { timeout: 5_000, timeoutMsg: `Settings tab "${label}" did not become active` },
  );
}

export async function waitForSetting(name: string): Promise<void> {
  await focusSettingsWindow();
  await browser.waitUntil(
    async () =>
      await browser.execute((settingName) => {
        const root = document.querySelector(".agentic-chat-settings-tabbody") ?? document;
        const items = Array.from(root.querySelectorAll<HTMLElement>(".setting-item"));
        return items.some(
          (item) => item.querySelector<HTMLElement>(".setting-item-name")?.innerText.trim() === settingName,
        );
      }, name),
    { timeout: 5_000, timeoutMsg: `Setting "${name}" did not render` },
  );
}

export async function setSettingSelect(name: string, value: string): Promise<void> {
  await waitForSetting(name);
  await browser.execute(
    ({ settingName, nextValue }) => {
      const findSetting = (name: string): HTMLElement | undefined => {
        const root = document.querySelector(".agentic-chat-settings-tabbody") ?? document;
        const items = Array.from(root.querySelectorAll<HTMLElement>(".setting-item"));
        return items.find((item) => item.querySelector<HTMLElement>(".setting-item-name")?.innerText.trim() === name);
      };
      const setting = findSetting(settingName);
      const select = setting?.querySelector<HTMLSelectElement>("select");
      if (!setting || !select) throw new Error(`Select for setting "${settingName}" not found`);
      select.value = nextValue;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    },
    { settingName: name, nextValue: value },
  );
}

export async function setSettingText(name: string, value: string): Promise<void> {
  await focusSettingsWindow();
  await waitForSetting(name);
  await browser.execute(
    ({ settingName, nextValue }) => {
      const findSetting = (name: string): HTMLElement | undefined => {
        const root = document.querySelector(".agentic-chat-settings-tabbody") ?? document;
        const items = Array.from(root.querySelectorAll<HTMLElement>(".setting-item"));
        return items.find((item) => item.querySelector<HTMLElement>(".setting-item-name")?.innerText.trim() === name);
      };
      const setting = findSetting(settingName);
      const input = setting?.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        "input:not([type='range']), textarea",
      );
      if (!setting || !input) throw new Error(`Text input for setting "${settingName}" not found`);
      input.focus();
      input.value = nextValue;
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: nextValue }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    },
    { settingName: name, nextValue: value },
  );
}

export async function setSettingRange(name: string, value: number): Promise<void> {
  await focusSettingsWindow();
  await waitForSetting(name);
  await browser.execute(
    ({ settingName, nextValue }) => {
      const findSetting = (name: string): HTMLElement | undefined => {
        const root = document.querySelector(".agentic-chat-settings-tabbody") ?? document;
        const items = Array.from(root.querySelectorAll<HTMLElement>(".setting-item"));
        return items.find((item) => item.querySelector<HTMLElement>(".setting-item-name")?.innerText.trim() === name);
      };
      const setting = findSetting(settingName);
      const input = setting?.querySelector<HTMLInputElement>("input[type='range']");
      if (!setting || !input) throw new Error(`Range input for setting "${settingName}" not found`);
      input.value = String(nextValue);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    },
    { settingName: name, nextValue: value },
  );
}

export async function setSettingToggle(name: string, checked: boolean): Promise<void> {
  await focusSettingsWindow();
  await waitForSetting(name);
  await browser.execute(
    ({ settingName, nextChecked }) => {
      const findSetting = (name: string): HTMLElement | undefined => {
        const root = document.querySelector(".agentic-chat-settings-tabbody") ?? document;
        const items = Array.from(root.querySelectorAll<HTMLElement>(".setting-item"));
        return items.find((item) => item.querySelector<HTMLElement>(".setting-item-name")?.innerText.trim() === name);
      };
      const setting = findSetting(settingName);
      if (!setting) throw new Error(`Toggle setting "${settingName}" not found`);
      const input = setting.querySelector<HTMLInputElement>("input[type='checkbox']");
      const toggle = setting.querySelector<HTMLElement>(".checkbox-container");
      const ariaChecked = toggle?.getAttribute("aria-checked");
      const classChecked = toggle?.classList.contains("is-enabled")
        ? true
        : toggle?.classList.contains("is-disabled")
          ? false
          : undefined;
      const currentlyChecked =
        ariaChecked === "true" ? true : ariaChecked === "false" ? false : classChecked ?? (input?.checked ? true : undefined);
      if (currentlyChecked === nextChecked) return;
      if (toggle) {
        toggle.click();
        return;
      }
      if (input) {
        input.click();
        return;
      }
      throw new Error(`Toggle control for setting "${settingName}" not found`);
    },
    { settingName: name, nextChecked: checked },
  );
}

export async function clickSettingButton(name: string, buttonText: string): Promise<void> {
  await waitForSetting(name);
  await browser.execute(
    ({ settingName, text }) => {
      const findSetting = (name: string): HTMLElement | undefined => {
        const root = document.querySelector(".agentic-chat-settings-tabbody") ?? document;
        const items = Array.from(root.querySelectorAll<HTMLElement>(".setting-item"));
        return items.find((item) => item.querySelector<HTMLElement>(".setting-item-name")?.innerText.trim() === name);
      };
      const setting = findSetting(settingName);
      const buttons = Array.from(setting?.querySelectorAll<HTMLButtonElement>("button") ?? []);
      const button = buttons.find((candidate) => candidate.innerText.trim() === text);
      if (!button) throw new Error(`Button "${text}" for setting "${settingName}" not found`);
      button.click();
    },
    { settingName: name, text: buttonText },
  );
}

export async function waitForSettingButton(name: string, buttonText: string): Promise<void> {
  await waitForSetting(name);
  await browser.waitUntil(
    async () =>
      await browser.execute(
        ({ settingName, text }) => {
          const root = document.querySelector(".agentic-chat-settings-tabbody") ?? document;
          const items = Array.from(root.querySelectorAll<HTMLElement>(".setting-item"));
          const setting = items.find(
            (item) => item.querySelector<HTMLElement>(".setting-item-name")?.innerText.trim() === settingName,
          );
          const buttons = Array.from(setting?.querySelectorAll<HTMLButtonElement>("button") ?? []);
          return buttons.some((candidate) => candidate.innerText.trim() === text);
        },
        { settingName: name, text: buttonText },
      ),
    { timeout: 5_000, timeoutMsg: `Button "${buttonText}" for setting "${name}" did not render` },
  );
}

export async function readAgenticChatSettings<T = Record<string, unknown>>(): Promise<T> {
  return await fromMainWindow(async () => {
    return await browser.executeObsidian(async ({ app }, pluginId) => {
      const plugin = (app as unknown as {
        plugins?: { plugins?: Record<string, { settings?: unknown }> };
      }).plugins?.plugins?.[pluginId];
      if (!plugin) throw new Error("agentic-chat plugin not found");
      return JSON.parse(JSON.stringify(plugin.settings)) as T;
    }, PLUGIN_ID);
  });
}

export async function readSecret(id: string): Promise<string> {
  return await fromMainWindow(async () => {
    return await browser.executeObsidian(async ({ app }, secretId) => {
      return (app as unknown as { secretStorage?: { getSecret?: (id: string) => string | null | undefined } }).secretStorage?.getSecret?.(secretId) ?? "";
    }, id);
  });
}

export async function readStoredData(): Promise<Record<string, unknown>> {
  return await fromMainWindow(async () => {
    return await browser.executeObsidian(async ({ app }) => {
      const raw = await app.vault.adapter.read(`${app.vault.configDir}/plugins/agentic-chat/data.json`);
      return JSON.parse(raw) as Record<string, unknown>;
    });
  });
}

export async function waitForAgenticChatSetting(
  predicate: (settings: Record<string, unknown>) => boolean,
  timeoutMsg: string,
): Promise<void> {
  await browser.waitUntil(async () => predicate(await readAgenticChatSettings()), { timeout: 5_000, timeoutMsg });
}