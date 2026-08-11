import { DEFAULT_PLUGINS_FOLDER } from "./loader";

/** Client-owned Agent Plugins settings: storage location + enable state. */
export interface PluginSettings {
  /** Vault folder scanned for Agent Plugins packages. */
  folder: string;
  /** Per-plugin enable toggles keyed by manifest name. Missing keys default to enabled. */
  enabled: Record<string, boolean>;
  /** True once legacy MCP servers have been converted into a "legacy-mcp" package. */
  migratedLegacy: boolean;
}

export const DEFAULT_PLUGIN_SETTINGS: PluginSettings = {
  folder: DEFAULT_PLUGINS_FOLDER,
  enabled: {},
  migratedLegacy: false,
};