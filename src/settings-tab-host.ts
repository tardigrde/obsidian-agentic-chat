import type { App, SettingDefinitionRender } from "obsidian";
import type AgenticChatPlugin from "./main";
import type { LoadedPlugin } from "./plugins/loader";
import type { secretInputDef } from "./settings-definition-kit";

/**
 * What the per-tab settings definition builders need from the settings tab that
 * hosts them. The tab owns lookup, writes, indexing, and redraws; the builders
 * only read settings and call these operations.
 */
export interface SettingsTabHost {
  readonly app: App;
  readonly plugin: AgenticChatPlugin;
  save(): Promise<void>;
  redraw(): void;
  refresh(): void;
  ensurePluginsLoaded(): void;
  /** Drop the once-only plugin load guard so the next redraw reloads packages. */
  invalidatePluginLoad(): void;
  externallyDeletedPlugins(): LoadedPlugin[];
  setExternallyDeletedPlugins(plugins: LoadedPlugin[]): void;
  secretInputDef(options: Parameters<typeof secretInputDef>[0]): SettingDefinitionRender;
}

/**
 * Parse a numeric text row. Out-of-range input clamps to the row bounds;
 * unparsable input returns undefined so the caller keeps the stored value.
 */
export function clampRowNumber(value: string, min: number, max: number): number | undefined {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.min(max, Math.max(min, parsed));
}
