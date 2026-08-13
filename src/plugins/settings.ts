import { DEFAULT_PLUGINS_FOLDER } from "./loader";

/** Client-owned Agent Plugins settings: storage location + enable state. */
export interface PluginSettings {
  /** Vault folder scanned for Agent Plugins packages. */
  folder: string;
  /** Per-plugin enable toggles keyed by manifest name. Missing keys default to enabled. */
  enabled: Record<string, boolean>;
  /**
   * Provenance label per plugin name ("github:owner/repo", an archive URL, or
   * a local description). Purely informational; lives in plugin settings so
   * the package itself stays spec-clean.
   */
  sources: Record<string, string>;
}

export const DEFAULT_PLUGIN_SETTINGS: PluginSettings = {
  folder: DEFAULT_PLUGINS_FOLDER,
  enabled: {},
  sources: {},
};