import { describe, expect, it } from "vitest";
import type { App, SettingControl } from "obsidian";
import { AgenticChatSettingTab } from "../src/settings";
import { normalizeControlValue } from "../src/settings-controls";
import { PROVIDERS, DEFAULT_SETTINGS } from "../src/settings-schema";

type Settings = typeof DEFAULT_SETTINGS;

function makeHarness(mutate?: (settings: Settings) => void) {
  const settings = structuredClone(DEFAULT_SETTINGS);
  mutate?.(settings);
  const plugin = {
    settings,
    settingsStore: {
      save: async () => undefined,
      update: async (mutator: (current: Settings) => boolean | void) => {
        if (mutator(settings) === false) return false;
        return true;
      },
    },
    saveSettings: async () => undefined,
    requestModeChange: async () => true,
    pluginService: {
      hasCache: () => false,
      hasRetainedImportBackup: () => false,
      reload: async () => [],
      getLoaded: () => [],
      invalidate: () => undefined,
      listExternallyDeletedPlugins: async () => [],
    },
  };
  return { tab: new AgenticChatSettingTab({} as App, plugin as never), settings };
}

function enableEverything(settings: Settings): void {
  settings.web.enabled = true;
  settings.mcp.enabled = true;
  settings.observability.enabled = true;
  settings.embeddings.enabled = true;
  settings.web.searchProvider = "searxng";
}

function collectControls(node: unknown, out: Map<string, SettingControl>): void {
  if (!node || typeof node !== "object") return;
  const item = node as { control?: SettingControl; items?: unknown[] };
  if (item.control?.key) out.set(item.control.key, item.control);
  for (const child of item.items ?? []) collectControls(child, out);
}

/** Every declarative control the tab can show, across provider and OTLP variants. */
function allControls(): SettingControl[] {
  const controls = new Map<string, SettingControl>();
  for (const provider of PROVIDERS) {
    for (const backend of ["langfuse", "otlp"] as const) {
      const { tab } = makeHarness((settings) => {
        enableEverything(settings);
        settings.provider = provider;
        settings.observability.backend = backend;
      });
      for (const page of tab.getSettingDefinitions()) collectControls(page, controls);
    }
  }
  return [...controls.values()];
}

function read(settings: Settings, key: string): unknown {
  return key.split(".").reduce<unknown>((value, part) => (value as Record<string, unknown>)[part], settings);
}

const MALFORMED: Record<string, unknown[]> = {
  toggle: ["yes", 1, null, undefined],
  dropdown: ["bogus", 42, null, undefined, ""],
  text: [42, null, undefined, { url: "x" }, true],
  slider: [Number.NaN, "5", null, Number.POSITIVE_INFINITY, -1e9, 1e9],
  number: [Number.NaN, "5", null, Number.NEGATIVE_INFINITY, -1e9, 1e9],
};

describe("setControlValue normalization (#286)", () => {
  const controls = allControls();

  it("finds the declarative controls the issue names", () => {
    const keys = controls.map((control) => control.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        "provider",
        "approval.mutating",
        "observability.proxyUrl",
        "observability.backend",
        "observability.payloadMode",
        "observability.authHeaderName",
        "embeddings.provider",
        "embeddings.languageCoverage",
        "web.searchProvider",
        "notifications.costCapUsd",
        "temperature",
      ]),
    );
    expect(controls.length).toBeGreaterThan(30);
  });

  for (const control of controls) {
    it(`never stores a malformed ${control.type} value for ${control.key}`, async () => {
      const malformed = MALFORMED[control.type];
      expect(malformed, `no malformed fixture for control type ${control.type}`).toBeDefined();
      for (const value of malformed) {
        const { tab, settings } = makeHarness(enableEverything);
        const before = read(settings, control.key);
        await tab.setControlValue(control.key, value);
        const after = read(settings, control.key);
        expect(typeof after, `${control.key} <- ${String(value)}`).toBe(typeof before);
        if (control.type === "dropdown") {
          expect(Object.keys(control.options)).toContain(after);
          expect(after).toBe(before);
        }
        if (control.type === "slider" || control.type === "number") {
          expect(Number.isFinite(after)).toBe(true);
          const min = control.min ?? Number.NEGATIVE_INFINITY;
          const max = control.max ?? Number.POSITIVE_INFINITY;
          expect(after as number).toBeGreaterThanOrEqual(min);
          expect(after as number).toBeLessThanOrEqual(max);
          if (typeof value !== "number" || Number.isNaN(value)) expect(after).toBe(before);
        }
        if (control.type === "toggle" || control.type === "text") expect(after).toBe(before);
      }
    });
  }

  it("stores observability.proxyUrl trimmed", async () => {
    const { tab, settings } = makeHarness();
    await tab.setControlValue("observability.proxyUrl", " http://p:8080 \n");
    await tab.setControlValue("observability.noProxy", "\tlocalhost,127.0.0.1  ");
    expect(settings.observability.proxyUrl).toBe("http://p:8080");
    expect(settings.observability.noProxy).toBe("localhost,127.0.0.1");
  });

  it("ignores an unknown provider id", async () => {
    const { tab, settings } = makeHarness();
    const before = settings.provider;
    await tab.setControlValue("provider", "bogus");
    expect(settings.provider).toBe(before);
    await tab.setControlValue("provider", "ollama");
    expect(settings.provider).toBe("ollama");
  });

  it("clamps numbers to the control range and keeps 0 as the cost-cap off value", async () => {
    const { tab, settings } = makeHarness();
    await tab.setControlValue("temperature", 7);
    await tab.setControlValue("web.maxResults", 0);
    await tab.setControlValue("notifications.costCapUsd", -3);
    expect(settings.temperature).toBe(2);
    expect(settings.web.maxResults).toBe(1);
    expect(settings.notifications.costCapUsd).toBe(0);
  });

  it("guards rows the current settings hide and keeps the live settings object", async () => {
    const { tab, settings } = makeHarness();
    const plugin = (tab as unknown as { plugin: { settings: Settings } }).plugin;
    expect(settings.web.enabled).toBe(false);
    await tab.setControlValue("web.searchProvider", "bogus");
    await tab.setControlValue("web.maxResults", 99);
    expect(plugin.settings).toBe(settings);
    expect(settings.web.searchProvider).toBe(DEFAULT_SETTINGS.web.searchProvider);
    expect(settings.web.maxResults).toBe(10);
  });

  it("indexes OTLP-only rows while the default backend hides them", async () => {
    const { tab, settings } = makeHarness();
    expect(settings.observability.backend).toBe("langfuse");
    await tab.setControlValue("observability.authHeaderName", "  X-OTel-Token \n");
    expect(settings.observability.authHeaderName).toBe("X-OTel-Token");
  });

  it("normalizeControlValue is a pure per-control rule", () => {
    const dropdown: SettingControl = { type: "dropdown", key: "k", options: { a: "A" } };
    const slider: SettingControl = { type: "slider", key: "k", min: 1, max: 5, step: 1 };
    expect(normalizeControlValue(dropdown, "b", "a")).toBe("a");
    expect(normalizeControlValue(dropdown, "a", "x")).toBe("a");
    expect(normalizeControlValue(slider, 9, 3)).toBe(5);
    expect(normalizeControlValue(slider, Number.NaN, 3)).toBe(3);
    expect(normalizeControlValue({ type: "text", key: "k" }, "  v \n", "")).toBe("v");
    expect(normalizeControlValue(undefined, 4, "s")).toBe("s");
  });

  it("keeps the empty base URL fallback", async () => {
    const { tab, settings } = makeHarness();
    await tab.setControlValue("openaiCompatibleBaseUrl", "   ");
    expect(settings.openaiCompatibleBaseUrl).toBe(DEFAULT_SETTINGS.openaiCompatibleBaseUrl);
  });
});
