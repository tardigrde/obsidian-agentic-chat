import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
  DEFAULT_OLLAMA_BASE_URL,
  type ModelConfig,
  type PrivacySettings,
  type ProviderId,
} from "./llm/models";
import { type ApprovalPolicy, type ApprovalSettings, DEFAULT_APPROVAL_SETTINGS } from "./agent/approval";
import { type AgentMode, DEFAULT_MODE, healMode } from "./agent/modes";
import { DEFAULT_OUTPUT_STYLE, type OutputStyle, OUTPUT_STYLES } from "./agent/output-styles";
import { DEFAULT_SYSTEM_PROMPT } from "./agent/system-prompt";
import { healMcpSettings, normalizeMcpNoProxy, normalizeMcpProxyUrl, type McpSettings } from "./mcp/settings";
import { WEB_SEARCH_PROVIDERS, type WebSearchProvider } from "./tools/web-search";
import {
  OPENAI_COMPATIBLE_API_KEY_SECRET_ID,
  OPENROUTER_API_KEY_SECRET_ID,
  WEB_SEARCH_API_KEY_SECRET_ID,
} from "./secrets/secret-store";
import { DEFAULT_PROJECT_SETTINGS, healProjectSettings, type ProjectSettings } from "./projects/projects";
import { DEFAULT_TOOL_BUDGET_SETTINGS, healToolBudgetSettings, type ToolBudgetSettings } from "./agent/tool-budget";
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
  /** Deprecated plaintext migration/fallback field. Persisted as empty after save. */
  openrouterApiKey: string;
  openrouterModel: string;
  ollamaBaseUrl: string;
  ollamaModel: string;
  openaiCompatibleBaseUrl: string;
  /** Secret id in Obsidian secretStorage. */
  openaiCompatibleApiKeySecretId: string;
  /** Deprecated plaintext migration/fallback field. Persisted as empty after save. */
  openaiCompatibleApiKey: string;
  openaiCompatibleModel: string;
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
  /** Vault folder scanned for SKILL.md skills/personas. Empty disables skills. */
  skillsFolder: string;
  /** Vault folder scanned for reusable prompt templates. Empty disables templates. */
  templatesFolder: string;
  /** Vault folder scanned for AGENT.md subagent profiles. Empty disables vault profiles. */
  agentsFolder: string;
  /** Include the built-in subagent roster (researcher / reviewer / editor). */
  enableBuiltinAgents: boolean;
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
  /** Desktop-only read-only file inspection for one configured external root. */
  external: ExternalWorkspaceSettings;
  /** Optional project workspaces that scope notes, tools, model/profile, and sessions. */
  projects: ProjectSettings;
  /** Optional semantic retrieval index configuration. Uses existing provider secrets. */
  embeddings: EmbeddingSettings;
  /** Optional opt-in OTLP/Langfuse observability export. */
  observability: ObservabilitySettings;
}

export interface NetworkSettings {
  /** Optional HTTP proxy URL used by plugin-owned request paths. */
  proxyUrl: string;
  /** Comma-separated hosts/domains that bypass the plugin proxy. */
  noProxy: string;
}

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
  /** API key for the chosen search provider (Tavily/Brave). */
  searchApiKey: string;
  /** Base URL of a self-hosted SearXNG instance (used only when provider is SearXNG). */
  searxngUrl: string;
  /** Default number of search results to return (1–10). */
  maxResults: number;
  /** Default cap on characters of fetched page text returned to the model. */
  fetchCharLimit: number;
}

export interface ExternalWorkspaceSettings {
  /** Master switch. When off, no external root tools are registered. */
  enabled: boolean;
  /** Absolute filesystem path to the one external root directory. */
  rootPath: string;
  /** Approval policy for read-only external_inspect calls. Defaults to ask. */
  approval: ApprovalPolicy;
  /** Also apply root and nested .gitignore files under the external root. */
  honorGitignore: boolean;
  /** Newline-separated gitignore-style globs scoped to the external root. */
  ignoredGlobs: string;
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

export const DEFAULT_EXTERNAL_IGNORED_GLOBS = [".env", ".env.*", "*.pem", "*.key", ".ssh/"].join("\n");

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
  skillsFolder: "",
  templatesFolder: "",
  agentsFolder: "",
  enableBuiltinAgents: true,
  ignoredGlobs: "",
  notifications: { enabled: true, costAlertUsd: 0, costCapUsd: 0 },
  compaction: { enabled: true, thresholdPercent: 80 },
  toolBudget: { ...DEFAULT_TOOL_BUDGET_SETTINGS },
  network: {
    proxyUrl: "",
    noProxy: "localhost,127.0.0.1,::1",
  },
  web: {
    enabled: false,
    searchProvider: "tavily",
    searchApiKeySecretId: WEB_SEARCH_API_KEY_SECRET_ID,
    searchApiKey: "",
    searxngUrl: "",
    maxResults: 5,
    fetchCharLimit: 10_000,
  },
  mcp: {
    enabled: false,
    proxyUrl: "",
    noProxy: "localhost,127.0.0.1,::1",
    servers: [],
  },
  external: {
    enabled: false,
    rootPath: "",
    approval: "ask",
    honorGitignore: true,
    ignoredGlobs: DEFAULT_EXTERNAL_IGNORED_GLOBS,
  },
  projects: DEFAULT_PROJECT_SETTINGS,
  embeddings: DEFAULT_EMBEDDING_SETTINGS,
  observability: DEFAULT_OBSERVABILITY_SETTINGS,
};

/** Merge stored settings over defaults, healing nested objects. */
export function mergeSettings(stored: Partial<AgenticChatSettings> | null | undefined): AgenticChatSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    // Heal enum-like fields so an unknown (or retired ask/plan/agent) value can't break the gate or prompt.
    provider: healProvider(stored?.provider),
    openrouterApiKeySecretId: stringSetting(stored?.openrouterApiKeySecretId, OPENROUTER_API_KEY_SECRET_ID),
    openaiCompatibleApiKeySecretId: stringSetting(
      stored?.openaiCompatibleApiKeySecretId,
      OPENAI_COMPATIBLE_API_KEY_SECRET_ID,
    ),
    mode: healMode(stored?.mode),
    outputStyle:
      stored?.outputStyle && stored.outputStyle in OUTPUT_STYLES ? stored.outputStyle : DEFAULT_OUTPUT_STYLE,
    privacy: { ...DEFAULT_SETTINGS.privacy, ...(stored?.privacy ?? {}) },
    approval: {
      ...DEFAULT_SETTINGS.approval,
      ...stored?.approval,
      perTool: { ...stored?.approval?.perTool },
      // Heal the granted working dirs to a string[] so a malformed persisted value
      // can't break the gate.
      workingDirs: Array.isArray(stored?.approval?.workingDirs)
        ? stored.approval.workingDirs.filter((dir): dir is string => typeof dir === "string")
        : [],
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
    },
    mcp: healMcpSettings(stored?.mcp),
    external: healExternalWorkspaceSettings(stored?.external),
    projects: healProjectSettings(stored?.projects),
    embeddings: healEmbeddingSettings(stored?.embeddings),
    observability: healObservabilitySettings(stored?.observability),
  };
}

function healExternalWorkspaceSettings(
  stored: Partial<ExternalWorkspaceSettings> | null | undefined,
): ExternalWorkspaceSettings {
  const approval: ApprovalPolicy =
    stored?.approval === "allow" || stored?.approval === "deny" || stored?.approval === "ask"
      ? stored.approval
      : DEFAULT_SETTINGS.external.approval;
  return {
    enabled: typeof stored?.enabled === "boolean" ? stored.enabled : DEFAULT_SETTINGS.external.enabled,
    rootPath: typeof stored?.rootPath === "string" ? stored.rootPath.trim() : DEFAULT_SETTINGS.external.rootPath,
    approval,
    honorGitignore:
      typeof stored?.honorGitignore === "boolean" ? stored.honorGitignore : DEFAULT_SETTINGS.external.honorGitignore,
    ignoredGlobs:
      typeof stored?.ignoredGlobs === "string" ? stored.ignoredGlobs : DEFAULT_SETTINGS.external.ignoredGlobs,
  };
}

function stringSetting(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function healNetworkSettings(stored: Partial<NetworkSettings> | null | undefined): NetworkSettings {
  return {
    proxyUrl: normalizeMcpProxyUrl(stored?.proxyUrl),
    noProxy: normalizeMcpNoProxy(stored?.noProxy),
  };
}

function healSearchProvider(stored: WebSearchProvider | undefined): WebSearchProvider {
  return stored && WEB_SEARCH_PROVIDERS.includes(stored) ? stored : DEFAULT_SETTINGS.web.searchProvider;
}

function healProvider(stored: ProviderId | undefined): ProviderId {
  return stored && PROVIDERS.includes(stored) ? stored : DEFAULT_SETTINGS.provider;
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
  };
}

/** API key for a provider. Ollama needs no real key but the OpenAI SDK wants a non-empty string. */
export function apiKeyForProvider(settings: AgenticChatSettings, provider: string): string | undefined {
  if (provider === "ollama") return "ollama";
  if (provider === "openai-compatible") return settings.openaiCompatibleApiKey.trim() || undefined;
  return settings.openrouterApiKey.trim() || undefined;
}

export const PROVIDERS: ProviderId[] = ["openrouter", "ollama", "openai-compatible"];

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  openrouter: "OpenRouter",
  ollama: "Ollama (local)",
  "openai-compatible": "OpenAI-compatible",
};
