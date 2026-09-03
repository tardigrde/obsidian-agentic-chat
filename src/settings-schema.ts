import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
  DEFAULT_OLLAMA_BASE_URL,
  healProviderId,
  type ModelConfig,
  type PrivacySettings,
  type ProviderId,
} from "./llm/models";
import { healPerToolMap, type ApprovalSettings, DEFAULT_APPROVAL_SETTINGS } from "./agent/approval";
import { normalizeWorkingDirs } from "./agent/working-dir";
import { type AgentMode, DEFAULT_MODE, healMode } from "./agent/modes";
import { DEFAULT_OUTPUT_STYLE, type OutputStyle, OUTPUT_STYLES } from "./agent/output-styles";
import { DEFAULT_SYSTEM_PROMPT } from "./agent/system-prompt";
import { DEFAULT_PLUGIN_SETTINGS, healPluginMcpState, type PluginSettings } from "./plugins/settings";
import { DEFAULT_PLUGINS_FOLDER } from "./plugins/loader";
import { healMcpSettings, mcpServerStateFromServer, type McpSettings } from "./mcp/settings";
import { WEB_SEARCH_PROVIDERS, type WebSearchProvider } from "./tools/web-search";
import {
  OPENAI_COMPATIBLE_API_KEY_SECRET_ID,
  OPENROUTER_API_KEY_SECRET_ID,
  WEB_SEARCH_API_KEY_SECRET_ID,
} from "./secrets/secret-store";
import { DEFAULT_TOOL_BUDGET_SETTINGS, healToolBudgetSettings, type ToolBudgetSettings } from "./agent/tool-budget";
import {
  DEFAULT_PROXY_SETTINGS,
  type ProxySettings,
  normalizeNoProxy,
  normalizeProxyUrl,
} from "./network/proxy";
import { normalizeAllowedHosts } from "./tools/web-allowlist";
import {
  DEFAULT_OBSERVABILITY_SETTINGS,
  healObservabilitySettings,
  type ObservabilitySettings,
} from "./observability/settings";
import {
  DEFAULT_EMBEDDING_SETTINGS,
  healEmbeddingSettings,
  type EmbeddingProviderId,
  type EmbeddingSettings,
} from "./retrieval/embeddings";

export interface AgenticChatSettings {
  provider: ProviderId;
  /** Secret id in Obsidian secretStorage. */
  openrouterApiKeySecretId: string;
  /**
   * @deprecated Runtime-only plaintext fallback for legacy data.json; persisted form omits this key entirely.
   * Secrets live in secretStorage via {@link openrouterApiKeySecretId}. Kept in-memory for {@link apiKeyForProvider}.
   */
  openrouterApiKey: string;
  openrouterModel: string;
  ollamaBaseUrl: string;
  ollamaModel: string;
  openaiCompatibleBaseUrl: string;
  /** Secret id in Obsidian secretStorage. */
  openaiCompatibleApiKeySecretId: string;
  /**
   * @deprecated Runtime-only plaintext fallback for legacy data.json; persisted form omits this key entirely.
   * Secrets live in secretStorage via {@link openaiCompatibleApiKeySecretId}.
   */
  openaiCompatibleApiKey: string;
  openaiCompatibleModel: string;
  /**
   * Optional context-window override for the OpenAI-compatible provider. 0 means
   * "auto-detect": try the OpenRouter catalog for the same model slug (exact or
   * confident suffix match), else treat the window as unknown. Unknown windows
   * keep all tools (the tool budget never drops) and disable auto-compaction.
   */
  openaiCompatibleContextWindow: number;
  /** Reasoning effort for your messages, set via the composer knob or `/effort`. */
  thinkingLevel: ThinkingLevel;
  temperature: number;
  /** 0 means "let the provider decide". */
  maxTokens: number;
  requestTimeoutMs: number;
  maxNetworkRetries: number;
  systemPrompt: string;
  /**
   * Session permission posture: `safe` honors the approval policy, `yolo` auto-approves
   * mutating tools. `plan` (read-only) is reached via the `/plan` command, not this default.
   */
  mode: AgentMode;
  /** How the assistant talks: a built-in system-prompt overlay. */
  outputStyle: OutputStyle;
  privacy: PrivacySettings;
  approval: ApprovalSettings;
  /** Agent Plugins packages loaded from a vault folder. */
  plugins: PluginSettings;
  /** Vault folder scanned for AGENT.md subagent profiles. Empty disables vault profiles. */
  agentsFolder: string;
  /** Include the built-in subagent roster (researcher / reviewer / editor). */
  enableBuiltinAgents: boolean;
  /** Auto-abort a subagent after this many seconds (max 86400). 0 disables the timeout. */
  subagentTimeoutSeconds: number;
  /**
   * Newline-separated gitignore-style globs the agent may never read or see.
   * Enforced at the tool layer; matched files are invisible, not just denied.
   */
  ignoredGlobs: string;
  /** Background notification preferences (toasts for agent/context/cost signals). */
  notifications: NotificationSettings;
  /** Auto-compaction: summarize old turns as the context window fills. */
  compaction: CompactionSettings;
  /** Tool-schema guard: withhold optional tools once registered tool definitions get large. */
  toolBudget: ToolBudgetSettings;
  /** Optional plugin-owned HTTP proxy for request paths the plugin controls. */
  network: NetworkSettings;
  /** Open-web access: search + fetch tools. Off by default — sends data off-device. */
  web: WebSettings;
  /** Remote MCP tools over HTTPS Streamable HTTP. Off by default — sends data off-device. */
  mcp: McpSettings;
  /** Optional semantic retrieval index configuration. Uses existing provider secrets. */
  embeddings: EmbeddingSettings;
  /** Optional opt-in OTLP/Langfuse observability export. */
  observability: ObservabilitySettings;
}

/**
 * The global network proxy every plugin-owned request path can inherit.
 * Shape and normalization are shared with the MCP and observability overrides
 * (see {@link ProxySettings}); empty proxyUrl means "no global proxy".
 */
export type NetworkSettings = ProxySettings;

export interface WebSettings {
  /**
   * Master egress gate for web search + fetch. Off by default. When off the web
   * tools are not registered at all, so the agent cannot reach the network.
   */
  enabled: boolean;
  /** Search backend. Tavily/Brave need an API key; SearXNG needs an instance URL. */
  searchProvider: WebSearchProvider;
  /** Secret id in Obsidian secretStorage. */
  searchApiKeySecretId: string;
  /**
   * @deprecated Runtime-only plaintext fallback for legacy data.json; persisted form omits this key entirely.
   * Secrets live in secretStorage via {@link searchApiKeySecretId}.
   */
  searchApiKey: string;
  /** Base URL of a self-hosted SearXNG instance (used only when provider is SearXNG). */
  searxngUrl: string;
  /** Default number of search results to return (1–10). */
  maxResults: number;
  /** Default cap on characters of fetched page text returned to the model. */
  fetchCharLimit: number;
  /** Comma-separated host suffixes for fetch_url allowlist; empty allows all public hosts. */
  allowedHosts: string;
}

export interface CompactionSettings {
  /** Summarize old turns automatically as the context window fills. */
  enabled: boolean;
  /** Context fill percent (50–95) at which compaction triggers. */
  thresholdPercent: number;
}

export interface NotificationSettings {
  /** Master switch for background toasts. Errors always show regardless. */
  enabled: boolean;
  /** Notify once when session cost crosses this USD amount. 0 disables. */
  costAlertUsd: number;
  /** Hard cap: block new turns (and abort the running one) once session cost reaches this USD. 0 disables. */
  costCapUsd: number;
}

export const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

export const DEFAULT_SETTINGS: AgenticChatSettings = {
  provider: "openrouter",
  openrouterApiKeySecretId: OPENROUTER_API_KEY_SECRET_ID,
  openrouterApiKey: "",
  openrouterModel: "moonshotai/kimi-k2.6",
  ollamaBaseUrl: DEFAULT_OLLAMA_BASE_URL,
  ollamaModel: "llama3.1",
  openaiCompatibleBaseUrl: DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
  openaiCompatibleApiKeySecretId: OPENAI_COMPATIBLE_API_KEY_SECRET_ID,
  openaiCompatibleApiKey: "",
  openaiCompatibleModel: "",
  openaiCompatibleContextWindow: 0,
  thinkingLevel: "off",
  temperature: 0.3,
  maxTokens: 0,
  requestTimeoutMs: 90_000,
  maxNetworkRetries: 2,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  mode: DEFAULT_MODE,
  outputStyle: DEFAULT_OUTPUT_STYLE,
  // Strongest privacy out of the box: zero data retention, no prompt
  // logging/training, and any fallback provider must also satisfy both.
  privacy: { denyDataCollection: true, requireZDR: true, allowFallbacks: true },
  approval: DEFAULT_APPROVAL_SETTINGS,
  plugins: DEFAULT_PLUGIN_SETTINGS,
  agentsFolder: "",
  enableBuiltinAgents: true,
  subagentTimeoutSeconds: 0,
  ignoredGlobs: "",
  notifications: { enabled: true, costAlertUsd: 0, costCapUsd: 0 },
  compaction: { enabled: true, thresholdPercent: 80 },
  toolBudget: { ...DEFAULT_TOOL_BUDGET_SETTINGS },
  network: { ...DEFAULT_PROXY_SETTINGS },
  web: {
    enabled: false,
    searchProvider: "tavily",
    searchApiKeySecretId: WEB_SEARCH_API_KEY_SECRET_ID,
    searchApiKey: "",
    searxngUrl: "",
    maxResults: 5,
    fetchCharLimit: 10_000,
    allowedHosts: "",
  },
  mcp: {
    enabled: false,
    ...DEFAULT_PROXY_SETTINGS,
    servers: [],
  },
  embeddings: DEFAULT_EMBEDDING_SETTINGS,
  observability: DEFAULT_OBSERVABILITY_SETTINGS,
};

/** Merge stored settings over defaults, healing nested objects. */
export function mergeSettings(stored: Partial<AgenticChatSettings> | null | undefined): AgenticChatSettings {
  // Drop retired feature keys (e.g. the removed `projects` workspaces) from the
  // persisted object so a legacy key from an older data.json is neither carried
  // nor re-saved.
  const remaining = { ...(stored ?? {}) };
  const retiredKeys = RETIRED_SETTING_KEYS.filter((key) => key in remaining);
  for (const key of retiredKeys) {
    delete (remaining as Record<string, unknown>)[key];
  }
  // Make the silent drop of hand-authored config visible (until the next save).
  if (retiredKeys.length > 0) {
    console.warn(`Agentic chat: dropped retired setting(s): ${retiredKeys.join(", ")}.`);
  }
  const healedMcp = healMcpSettings(stored?.mcp);
  const healedPlugins = healPluginSettings(stored?.plugins);
  // One-time migration S10: legacy plugin servers persisted in mcp.servers → plugins.mcpState map.
  // Client state (enabled/approval/auth/knownTools/oauth) moves by stable id; shape stays in mcp.json.
  // User servers (source=user) stay in mcp.servers for backward compat until they are re-created as plugins.
  if (healedMcp.servers.length > 0) {
    let migrated = false;
    const remainingServers: typeof healedMcp.servers = [];
    for (const server of healedMcp.servers) {
      if (server.source === "plugin" && !healedPlugins.mcpState[server.id]) {
        healedPlugins.mcpState[server.id] = mcpServerStateFromServer(server);
        migrated = true;
      } else if (server.source === "plugin" && healedPlugins.mcpState[server.id]) {
        // Already migrated — drop the persisted copy to avoid divergence.
        migrated = true;
      } else {
        remainingServers.push(server);
      }
    }
    if (migrated) {
      healedMcp.servers = remainingServers;
    }
  }
  return {
    ...DEFAULT_SETTINGS,
    ...remaining,
    // Heal enum-like fields so an unknown (or retired ask/plan/agent) value can't break the gate or prompt.
    provider: healProvider(stored?.provider),
    openrouterApiKeySecretId: stringSetting(stored?.openrouterApiKeySecretId, OPENROUTER_API_KEY_SECRET_ID),
    // Deprecated runtime-only plaintext: coerce so a corrupt non-string value
    // can't reach apiKeyForProvider's .trim().
    openrouterApiKey: typeof stored?.openrouterApiKey === "string" ? stored.openrouterApiKey : "",
    openaiCompatibleApiKeySecretId: stringSetting(
      stored?.openaiCompatibleApiKeySecretId,
      OPENAI_COMPATIBLE_API_KEY_SECRET_ID,
    ),
    openaiCompatibleApiKey: typeof stored?.openaiCompatibleApiKey === "string" ? stored.openaiCompatibleApiKey : "",
    mode: healMode(stored?.mode),
    openaiCompatibleContextWindow: healContextWindow(stored?.openaiCompatibleContextWindow),
    outputStyle:
      stored?.outputStyle && stored.outputStyle in OUTPUT_STYLES ? stored.outputStyle : DEFAULT_OUTPUT_STYLE,
    privacy: { ...DEFAULT_SETTINGS.privacy, ...(stored?.privacy ?? {}) },
    approval: {
      ...DEFAULT_SETTINGS.approval,
      ...stored?.approval,
      perTool: healPerToolMap(stored?.approval?.perTool),
      // Heal the granted working dirs to a string[] so a malformed persisted value
      // can't break the gate. Also drop plugin-internal paths that would fail-open the boundary.
      workingDirs: normalizeWorkingDirs(
        Array.isArray(stored?.approval?.workingDirs)
          ? stored.approval.workingDirs.filter((dir): dir is string => typeof dir === "string")
          : [],
      ),
    },
    notifications: { ...DEFAULT_SETTINGS.notifications, ...stored?.notifications },
    compaction: { ...DEFAULT_SETTINGS.compaction, ...stored?.compaction },
    toolBudget: healToolBudgetSettings(stored?.toolBudget),
    network: healNetworkSettings(stored?.network),
    web: {
      ...DEFAULT_SETTINGS.web,
      ...stored?.web,
      // Heal the provider enum so an unknown persisted value can't break search.
      searchProvider: healSearchProvider(stored?.web?.searchProvider),
      searchApiKeySecretId: stringSetting(stored?.web?.searchApiKeySecretId, WEB_SEARCH_API_KEY_SECRET_ID),
      allowedHosts: normalizeAllowedHosts(stored?.web?.allowedHosts),
    },
    mcp: healedMcp,
    plugins: healedPlugins,
    subagentTimeoutSeconds: healSubagentTimeout(stored?.subagentTimeoutSeconds),
    embeddings: healEmbeddingSettings(stored?.embeddings),
    observability: healObservabilitySettings(stored?.observability),
  };
}

function stringSetting(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

/** Retired feature keys removed from persisted data.json on load. */
const RETIRED_SETTING_KEYS = ["projects"] as const;

/** Upper bound for the subagent timeout (24h) — keeps `setTimeout` under its 32-bit delay range. */
export const MAX_SUBAGENT_TIMEOUT_SECONDS = 86_400;

/** Heal the subagent auto-abort timeout: whole seconds clamped to [0, 24h]; 0 = disabled. */
export function healSubagentTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(Math.max(0, Math.trunc(value)), MAX_SUBAGENT_TIMEOUT_SECONDS);
}

/** Heal the context-window override: 0 = auto-detect, otherwise a positive integer. */
function healContextWindow(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function healNetworkSettings(stored: Partial<NetworkSettings> | null | undefined): NetworkSettings {
  return {
    proxyUrl: normalizeProxyUrl(stored?.proxyUrl),
    noProxy: normalizeNoProxy(stored?.noProxy),
  };
}

function healSearchProvider(stored: WebSearchProvider | undefined): WebSearchProvider {
  return stored && WEB_SEARCH_PROVIDERS.includes(stored) ? stored : DEFAULT_SETTINGS.web.searchProvider;
}

function healPluginSettings(stored: Partial<PluginSettings> | null | undefined): PluginSettings {
  const enabled: Record<string, boolean> = {};
  if (stored?.enabled && typeof stored.enabled === "object" && !Array.isArray(stored.enabled)) {
    for (const [name, value] of Object.entries(stored.enabled)) {
      enabled[name] = value === true;
    }
  }
  const sources: Record<string, string> = {};
  if (stored?.sources && typeof stored.sources === "object" && !Array.isArray(stored.sources)) {
    for (const [name, value] of Object.entries(stored.sources)) {
      if (typeof value === "string" && value.trim()) sources[name] = value.trim();
    }
  }
  const mcpState = healPluginMcpState(
    (stored as Record<string, unknown>)?.mcpState as Record<string, unknown> | null | undefined,
  );
  return {
    folder: healPluginsFolder(stored?.folder),
    enabled,
    sources,
    mcpState,
  };
}

function healPluginsFolder(raw: unknown): string {
  if (typeof raw !== "string") return DEFAULT_PLUGINS_FOLDER;
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return DEFAULT_PLUGINS_FOLDER;
  // Reject absolute, traversal, or colon (Windows drive / URL) to keep deletes confined.
  if (trimmed.startsWith("/") || trimmed.includes(":") || trimmed.includes("\\")) {
    return DEFAULT_PLUGINS_FOLDER;
  }
  const segments = trimmed.split("/").filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment === ".." || segment === ".")) {
    return DEFAULT_PLUGINS_FOLDER;
  }
  // Allow dot-folders like .agentic-plugins, but require at least one non-dot segment char
  if (segments.some((segment) => segment.length === 0)) return DEFAULT_PLUGINS_FOLDER;
  return trimmed;
}

function healProvider(stored: ProviderId | undefined): ProviderId {
  return healProviderId(stored, DEFAULT_SETTINGS.provider);
}

export function embeddingModelPlaceholder(provider: EmbeddingProviderId): string {
  if (provider === "ollama") return DEFAULT_EMBEDDING_SETTINGS.ollamaModel;
  if (provider === "openai-compatible") return "text-embedding-model";
  return DEFAULT_EMBEDDING_SETTINGS.openrouterModel;
}

/** The model id used for the active provider. */
export function activeModelId(settings: AgenticChatSettings): string {
  if (settings.provider === "ollama") return settings.ollamaModel;
  if (settings.provider === "openai-compatible") return settings.openaiCompatibleModel;
  return settings.openrouterModel;
}

/** Resolve the active provider/model into a buildable model config. */
export function activeModelConfig(settings: AgenticChatSettings): ModelConfig {
  return {
    provider: settings.provider,
    modelId: activeModelId(settings),
    privacy: settings.privacy,
    ollamaBaseUrl: settings.ollamaBaseUrl || DEFAULT_OLLAMA_BASE_URL,
    openaiCompatibleBaseUrl: settings.openaiCompatibleBaseUrl || DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
    openaiCompatibleContextWindow: settings.openaiCompatibleContextWindow,
  };
}

/** API key for a provider. Ollama needs no real key but the OpenAI SDK wants a non-empty string. */
export function apiKeyForProvider(settings: AgenticChatSettings, provider: string): string | undefined {
  if (provider === "ollama") return "ollama";
  if (provider === "openai-compatible") return settings.openaiCompatibleApiKey.trim() || undefined;
  return settings.openrouterApiKey.trim() || undefined;
}

// Re-exported for the settings UI and tests; defined next to ProviderId in llm/models.
export { PROVIDERS } from "./llm/models";

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  openrouter: "OpenRouter",
  ollama: "Ollama (local)",
  "openai-compatible": "OpenAI-compatible",
};
