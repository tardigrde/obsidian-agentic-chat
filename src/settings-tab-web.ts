import type { SettingDefinitionItem } from "obsidian";
import { DEFAULT_PROXY_SETTINGS, PROXY_URL_EXAMPLE } from "./network/proxy";
import type { ObservabilityBackend, ObservabilityPayloadMode } from "./observability/settings";
import { controlDef, row, warning } from "./settings-definition-kit";
import type { AgenticChatSettings } from "./settings-schema";
import { WEB_SEARCH_PROVIDER_LABELS, WEB_SEARCH_PROVIDERS } from "./tools/web-search";
import { normalizeAllowedHosts } from "./tools/web-allowlist";
import { clampRowNumber, type SettingsTabHost } from "./settings-tab-host";

const OBSERVABILITY_BACKEND_LABELS: Record<ObservabilityBackend, string> = {
  langfuse: "Langfuse",
  otlp: "Generic OTLP",
};

const OBSERVABILITY_PAYLOAD_LABELS: Record<ObservabilityPayloadMode, string> = {
  metadata: "Metadata only",
  "redacted-previews": "Redacted text previews",
  "full-content": "Full prompt/output content",
};

export function webDefinitions(settings: AgenticChatSettings, host: SettingsTabHost): SettingDefinitionItem[] {
  const items: SettingDefinitionItem[] = [
    warning(
      "⚠",
      "Web search and fetch send your query text and the URLs the agent opens to a third-party " +
        "service, off-device — outside the vault's privacy boundary. Off by default; turn it on only " +
        "when you want the agent to use the open web.",
    ),
    controlDef(
      "Enable web search & fetch",
      { type: "toggle", key: "web.enabled" },
      "Give the agent web_search and fetch_url tools. When off, the agent cannot reach the network at all.",
    ),
  ];

  if (!settings.web.enabled) return items;

  items.push(
    controlDef(
      "Search provider",
      {
        type: "dropdown",
        key: "web.searchProvider",
        options: Object.fromEntries(WEB_SEARCH_PROVIDERS.map((provider) => [provider, WEB_SEARCH_PROVIDER_LABELS[provider]])),
      },
      "Backend for web_search. Tavily and Brave need an API key; SearXNG needs a self-hosted instance URL.",
    ),
  );

  if (settings.web.searchProvider === "searxng") {
    items.push(
      controlDef(
        "SearXNG instance URL",
        { type: "text", key: "web.searxngUrl", placeholder: "https://searx.example.com" },
        "Base URL of your SearXNG instance, e.g. https://searx.example.com. The JSON API must be enabled.",
      ),
    );
  } else {
    items.push(
      host.secretInputDef({
        name: "Search API key",
        desc:
          settings.web.searchProvider === "tavily"
            ? "Tavily API key (tavily.com)."
            : "Brave Search API key (brave.com/search/api).",
        placeholder: settings.web.searchProvider === "tavily" ? "tvly-..." : "BSA...",
        hasValue: () => Boolean(settings.web.searchApiKey),
        onSet: async (value) => {
          settings.web.searchApiKey = value;
          await host.save();
        },
        onForget: async () => {
          settings.web.searchApiKey = "";
          await host.save();
        },
      }),
    );
  }

  items.push(
    controlDef(
      "Search results",
      { type: "slider", key: "web.maxResults", min: 1, max: 10, step: 1 },
      "How many results web_search returns by default.",
    ),
    row("Fetched page character limit", (setting) => {
      setting
        .setDesc("Maximum characters of a fetched page's text returned to the model.")
        .addText((text) => {
          text.inputEl.type = "number";
          text.inputEl.setAttribute("min", "500");
          text.setValue(String(settings.web.fetchCharLimit)).onChange(async (value) => {
            const limit = clampRowNumber(value, 500, Number.POSITIVE_INFINITY);
            if (limit !== undefined) settings.web.fetchCharLimit = limit;
            await host.save();
          });
        });
    }),
    row("Allowed hosts", (setting) => {
      setting
        .setDesc(
          "Optional comma-separated host suffixes for fetch_url. Empty allows any public host. " +
            'Example: example.com, *.wikipedia.org — blocks other hosts with "Blocked by allowlist".',
        )
        .addText((text) =>
          text
            .setPlaceholder("example.com, *.wikipedia.org")
            .setValue(settings.web.allowedHosts)
            .onChange(async (value) => {
              settings.web.allowedHosts = normalizeAllowedHosts(value);
              await host.save();
              // Update the field to the canonical (lower-cased, deduped) value so typos like `Example.COM` are visible immediately.
              text.setValue(settings.web.allowedHosts);
            }),
        );
    }),
  );
  return items;
}

export function observabilityDefinitions(
  settings: AgenticChatSettings,
  host: SettingsTabHost,
): SettingDefinitionItem[] {
  const items: SettingDefinitionItem[] = [
    warning(
      "i",
      "Observability is opt-in and has no built-in endpoint. When enabled, Agentic Chat exports " +
        "turn, model, tool, approval, token, and cost metadata to the endpoint you configure. Prompt " +
        "and answer text is withheld unless you explicitly change payload detail below.",
    ),
    controlDef(
      "Enable observability",
      { type: "toggle", key: "observability.enabled" },
      "Export OTLP/HTTP traces for agent turns. Leave off for the default no-telemetry behavior.",
    ),
  ];

  if (!settings.observability.enabled) return items;

  items.push(
    controlDef(
      "Backend",
      {
        type: "dropdown",
        key: "observability.backend",
        options: Object.fromEntries(
          (Object.keys(OBSERVABILITY_BACKEND_LABELS) as ObservabilityBackend[]).map((backend) => [
            backend,
            OBSERVABILITY_BACKEND_LABELS[backend],
          ]),
        ),
      },
      "Langfuse configures OTLP headers for Langfuse ingestion; generic OTLP accepts a direct /v1/traces endpoint.",
    ),
    controlDef(
      settings.observability.backend === "langfuse" ? "Langfuse base URL" : "OTLP traces endpoint",
      {
        type: "text",
        key: "observability.endpoint",
        placeholder:
          settings.observability.backend === "langfuse"
            ? "https://langfuse.example.com"
            : "https://otel.example.com/v1/traces",
      },
      settings.observability.backend === "langfuse"
        ? "Corporate/self-hosted Langfuse base URL. The plugin posts to /api/public/otel/v1/traces."
        : "Full OTLP HTTP/JSON traces endpoint, usually ending in /v1/traces.",
    ),
    controlDef(
      "Payload detail",
      {
        type: "dropdown",
        key: "observability.payloadMode",
        options: Object.fromEntries(
          (Object.keys(OBSERVABILITY_PAYLOAD_LABELS) as ObservabilityPayloadMode[]).map((mode) => [
            mode,
            OBSERVABILITY_PAYLOAD_LABELS[mode],
          ]),
        ),
      },
      "Metadata only sends timings, model ids, token/cost totals, tool names, approvals, and errors. " +
        "Text modes send prompt/answer text to the configured backend.",
    ),
    controlDef(
      "Sample rate",
      { type: "slider", key: "observability.sampleRate", min: 0, max: 100, step: 1 },
      "Percentage of agent turns to export.",
    ),
    controlDef(
      "HTTP proxy",
      { type: "text", key: "observability.proxyUrl", placeholder: PROXY_URL_EXAMPLE },
      "Optional observability-only override. Leave empty to inherit the global network proxy from the Models tab.",
    ),
    controlDef(
      "No proxy",
      { type: "text", key: "observability.noProxy", placeholder: DEFAULT_PROXY_SETTINGS.noProxy },
      "Comma-separated hosts/domains that bypass the observability proxy.",
    ),
  );

  if (settings.observability.backend === "langfuse") {
    items.push(
      host.secretInputDef({
        name: "Langfuse public key",
        desc: "Public key for the configured Langfuse project.",
        placeholder: "pk-lf-...",
        hasValue: () => Boolean(settings.observability.langfusePublicKey),
        onSet: async (value) => {
          settings.observability.langfusePublicKey = value;
          await host.save();
        },
        onForget: async () => {
          settings.observability.langfusePublicKey = "";
          await host.save();
        },
      }),
      host.secretInputDef({
        name: "Langfuse secret key",
        desc: "Secret key for the configured Langfuse project.",
        placeholder: "sk-lf-...",
        hasValue: () => Boolean(settings.observability.langfuseSecretKey),
        onSet: async (value) => {
          settings.observability.langfuseSecretKey = value;
          await host.save();
        },
        onForget: async () => {
          settings.observability.langfuseSecretKey = "";
          await host.save();
        },
      }),
    );
    return items;
  }

  items.push(
    controlDef(
      "Auth header name",
      { type: "text", key: "observability.authHeaderName", placeholder: "Authorization" },
      "Optional header name for a generic OTLP backend, e.g. Authorization.",
    ),
    host.secretInputDef({
      name: "Auth header value",
      desc: "Optional header value for the generic OTLP backend.",
      placeholder: "Bearer ...",
      hasValue: () => Boolean(settings.observability.authHeaderValue),
      onSet: async (value) => {
        settings.observability.authHeaderValue = value;
        await host.save();
      },
      onForget: async () => {
        settings.observability.authHeaderValue = "";
        await host.save();
      },
    }),
  );
  return items;
}
