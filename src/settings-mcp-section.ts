import { type App, type ButtonComponent, Notice, Platform, type SettingDefinitionItem, type SettingDefinitionRender } from "obsidian";
import type AgenticChatPlugin from "./main";
import { type ApprovalPolicy, clearMcpPerToolApprovals, setPerToolApproval } from "./agent/approval";
import { createMcpFetcher } from "./mcp/fetcher";
import {
  authenticateMcpServer,
  DEFAULT_MCP_OAUTH_REDIRECT_URI,
  forgetMcpOAuthTokens,
  hasMcpOAuthAccess,
  MCP_OAUTH_OBSIDIAN_REDIRECT_URI,
  type McpOAuthProgressEvent,
} from "./mcp/oauth";
import {
  exportMcpServerConfig,
  mcpServerSetupSteps,
  normalizeMcpServerId,
  type McpAuthType,
  type McpServerSettings,
} from "./mcp/settings";
import { healMcpToolGlobs } from "./mcp/tool-filter";
import { probeMcpServer } from "./mcp/tools";
import { effectiveProxy, DEFAULT_PROXY_SETTINGS, PROXY_URL_EXAMPLE } from "./network/proxy";
import { resolveMcpServers } from "./plugins/loader";
import { validateMcpUrl } from "./plugins/manifest";
import {
  block,
  controlDef,
  copyToClipboard,
  headingRow,
  renderItemsInto,
  row,
  secretInputDef,
  warning,
} from "./settings-definition-kit";
import {
  clearMcpSecretSlots,
  nextMcpServerId,
  renameMcpServer,
  syncMcpServerToState,
  updateMcpServerEndpoint,
} from "./settings-mcp-edits";
import {
  formatMcpServerSummary,
  formatMcpToolApprovalDescription,
  formatMcpToolSample,
  mcpAuthProblem,
  mcpEndpointProblem,
  mcpKnownToolLocalName,
  mcpTestButtonState,
} from "./settings-mcp-state";
import type { AgenticChatSettings, NetworkSettings } from "./settings-schema";
import { errorMessage } from "./utils/errors";

/** What the MCP section needs from the settings tab that hosts it. */
export interface McpSettingsHost {
  readonly app: App;
  readonly plugin: AgenticChatPlugin;
  save(): Promise<void>;
  redraw(): void;
  ensurePluginsLoaded(): void;
  /** Drop the once-only plugin load guard so the next redraw reloads packages. */
  invalidatePluginLoad(): void;
}

/** The MCP tab section: global MCP toggles, the add-server form, and one block per server. */
export class McpSettingsSection {
  private pendingMcpServerName = "";
  private pendingMcpServerUrl = "";

  constructor(private readonly host: McpSettingsHost) {}

  private mcpDisplayServers(settings: AgenticChatSettings): McpServerSettings[] {
    const pluginServers = this.host.plugin.pluginService.getLoaded().filter((p) => p.enabled).flatMap((p) => p.mcpServers);
    // Use the same resolution as the runtime (state map primary, legacy mcp.servers fallback for tests/pre-migration).
    return resolveMcpServers(settings, pluginServers);
  }

  definitions(): SettingDefinitionItem[] {
    const settings = this.host.plugin.settings;
    const enabled = () => settings.mcp.enabled;
    return [
      warning(
        "⚠",
        "MCP tools send tool names and arguments to configured remote MCP servers. Only HTTPS " +
          "Streamable HTTP endpoints are supported; stdio and subprocess servers are intentionally unsupported.",
      ),
      controlDef(
        "Enable MCP",
        { type: "toggle", key: "mcp.enabled" },
        "Discover and register tools from configured HTTPS MCP servers.",
      ),
      controlDef(
        "HTTP proxy",
        { type: "text", key: "mcp.proxyUrl", placeholder: PROXY_URL_EXAMPLE },
        "Optional MCP-only override. Leave empty to inherit the global network proxy from the Models tab.",
        { visible: enabled },
      ),
      controlDef(
        "No proxy",
        { type: "text", key: "mcp.noProxy", placeholder: DEFAULT_PROXY_SETTINGS.noProxy },
        "Comma-separated hosts/domains that bypass the MCP proxy.",
        { visible: enabled },
      ),
      block(
        (setting) => {
          const heading = setting.settingEl.createDiv({ cls: "agentic-chat-mcp-heading" });
          heading.createDiv({ text: "Add MCP server", cls: "agentic-chat-mcp-heading-title" });
          heading.createDiv({
            text:
              "Writes a real agent plugin package (plugin.json + mcp.json) into the plugins folder. " +
              "Packages, not settings, own server endpoints after creation.",
            cls: "setting-item-description",
          });
        },
        { name: "Add MCP server", visible: enabled },
      ),
      row(
        "",
        (setting) => {
          setting
            .setClass("agentic-chat-mcp-add")
            .addText((text) =>
              text
                .setPlaceholder("Server name")
                .setValue(this.pendingMcpServerName)
                .onChange((value) => {
                  this.pendingMcpServerName = value;
                }),
            )
            .addText((text) =>
              text
                .setPlaceholder("https://mcp.example.com/mcp")
                .setValue(this.pendingMcpServerUrl)
                .onChange((value) => {
                  this.pendingMcpServerUrl = value;
                }),
            )
            .addButton((button) =>
              button.setButtonText("Add MCP server").onClick(async () => {
                const url = this.pendingMcpServerUrl.trim();
                const name = this.pendingMcpServerName.trim();
                if (!name || !url) {
                  new Notice("Agentic Chat MCP: enter a server name and an HTTPS (or loopback HTTP) endpoint.");
                  return;
                }
                try {
                  if (validateMcpUrl(url) !== null) throw new Error("only HTTPS (or loopback HTTP) endpoints are supported");
                  // Package creation can fail mid-write (stale file tree, an
                  // externally synced folder of the same name, interrupted writes);
                  // surface it instead of dropping the rejection on the floor.
                  const result = await this.host.plugin.pluginService.generateMcpServerPackage({ serverName: name, url });
                  this.pendingMcpServerName = "";
                  this.pendingMcpServerUrl = "";
                  // The package is new; drop the once-only load guard so the next
                  // redraw picks it up from the vault.
                  this.host.invalidatePluginLoad();
                  new Notice(`Agentic Chat MCP: created plugin package at ${result.rootPath}.`);
                  this.host.redraw();
                } catch (error) {
                  new Notice(`Agentic Chat MCP: ${errorMessage(error)}`);
                }
              }),
            );
        },
        { visible: enabled },
      ),
      block(
        (setting) => {
          // Read the collection at render time: packages and legacy user rows
          // can change while the settings modal stays open.
          this.host.ensurePluginsLoaded();
          const displayServers = this.mcpDisplayServers(settings);
          if (displayServers.length === 0) {
            setting.settingEl.createDiv({
              cls: "setting-item-description",
              text: "No MCP servers. Generate a plugin package above, or add a plugin folder with an mcp.json inside the plugin folder.",
            });
            return;
          }
          renderItemsInto(
            setting.settingEl,
            displayServers.flatMap((server) => this.mcpServerDefinitions(settings, server)),
          );
        },
        { name: "MCP servers", visible: enabled },
      ),
    ];
  }

  private mcpServerDefinitions(
    settings: AgenticChatSettings,
    server: McpServerSettings,
  ): SettingDefinitionItem[] {
    const pluginManaged = server.source === "plugin";
    const items: SettingDefinitionItem[] = [];

    items.push(
      row(server.name || server.id, (setting) => {
        const endpointProblem = mcpEndpointProblem(server.url);
        setting
          .setName(server.name || server.id)
          .setDesc(
            formatMcpServerSummary(server, endpointProblem) + (pluginManaged ? ` (managed by ${server.pluginRoot})` : ""),
          )
          .setClass("agentic-chat-mcp-server-header")
          .setClass("agentic-chat-setting-heading-wrap")
          .setHeading();
        let testButton: ButtonComponent | undefined;
        const syncTestButton = (): void => {
          if (!testButton) return;
          const state = mcpTestButtonState(server);
          testButton.setButtonText(state.label).setDisabled(Boolean(state.problem));
        };
        setting.addToggle((toggle) =>
          toggle.setValue(server.enabled).onChange(async (value) => {
            server.enabled = value;
            this.syncMcpServerToState(server);
            await this.host.save();
          }),
        );
        setting.addButton((button) => {
          testButton = button;
          syncTestButton();
          return button.onClick(async () => {
            const state = mcpTestButtonState(server);
            if (state.problem) {
              new Notice(state.problem);
              syncTestButton();
              return;
            }
            await this.runMcpButtonAction(
              button,
              state.label,
              state.busyLabel,
              () => (state.needsOAuthSignIn ? this.authenticateAndProbeMcpServer(server) : this.testMcpServer(server)),
            );
            syncTestButton();
          });
        });

        if (server.authType === "oauth") {
          setting.addButton((button) =>
            button
              .setButtonText("Re-authenticate")
              .setDisabled(Boolean(endpointProblem))
              .onClick(async () => {
                if (endpointProblem) {
                  new Notice(endpointProblem);
                  return;
                }
                await this.runMcpButtonAction(button, "Re-authenticate", "Authenticating...", () =>
                  this.authenticateAndProbeMcpServer(server),
                );
              }),
          );
        }

        setting.addButton((button) =>
          button
            .setButtonText("Remove")
            .setClass("mod-warning")
            .setDisabled(pluginManaged)
            .onClick(async () => {
              clearMcpPerToolApprovals(settings.approval, server.id);
              clearMcpSecretSlots(this.host.app, server);
              settings.mcp.servers = settings.mcp.servers.filter((entry) => entry !== server);
              await this.host.save();
              this.host.redraw();
            }),
        );
      }),
    );

    // Show banner when server advertised OAuth via 401 but authType is still none/bearer/header
    if (server.pendingOAuthChallenge && server.pendingOAuthResourceUrl) {
      items.push(
        block((setting) => {
          const banner = setting.settingEl.createDiv({ cls: "setting-item-description agentic-chat-oauth-banner" });
          const isNone = server.authType === "none";
          banner.createSpan({
            text: isNone
              ? `This server requires OAuth (resource: ${server.pendingOAuthResourceUrl}). Click Authenticate & test to sign in — no need to change the Authentication dropdown manually.`
              : `This server advertises OAuth (resource: ${server.pendingOAuthResourceUrl}) but is set to ${server.authType}. `,
          });
          if (!isNone) {
            const switchBtn = banner.createEl("button", { text: "Switch to OAuth", cls: "mod-cta" });
            switchBtn.addEventListener("click", () => {
              void (async () => {
                server.authType = "oauth";
                server.pendingOAuthChallenge = undefined;
                server.pendingOAuthResourceUrl = undefined;
                this.syncMcpServerToState(server);
                await this.host.save();
                this.host.redraw();
              })();
            });
          }
        }),
      );
    }

    if (pluginManaged) {
      items.push(
        block((setting) => {
          setting.settingEl.createDiv({
            cls: "setting-item-description",
            text:
              `This server lives in the "${server.pluginRoot}" agent plugin package. ` +
              "Its endpoint and literal headers come from mcp.json; authentication is configured client-side " +
              "and stays with this plugin. Remove the package folder to delete the server.",
          });
        }),
      );
    }

    items.push(
      row("Name", (setting) => {
        setting.setDesc("Shown in tool labels and approval prompts.").addText((text) =>
          text
            .setDisabled(pluginManaged)
            .setValue(server.name)
            .onChange(async (value) => {
              server.name = value.trim() || server.id;
              await this.host.save();
            }),
        );
      }),
      row("Server id", (setting) => {
        setting.setDesc("Advanced. Used in local tool names: mcp__<id>__<tool>.").addText((text) =>
          text
            .setDisabled(pluginManaged)
            .setValue(server.id)
            .onChange(async (value) => {
              const next = normalizeMcpServerId(value);
              renameMcpServer(this.host.app, settings, server, nextMcpServerId(settings, next, server));
              await this.host.save();
            }),
        );
      }),
      row("HTTPS endpoint", (setting) => {
        const endpointProblem = mcpEndpointProblem(server.url);
        setting
          .setDesc(endpointProblem || "Streamable HTTP endpoint. Query parameters are preserved. Loopback hosts may use http://.")
          .addText((text) =>
            text
              .setDisabled(pluginManaged)
              .setPlaceholder("https://mcp.example.com/mcp")
              .setValue(server.url)
              .onChange(async (value) => {
                const result = updateMcpServerEndpoint(this.host.app, settings, server, value);
                await this.host.save();
                if (result.clearedCredentials) new Notice(`${server.name}: cleared MCP credentials for the changed endpoint.`);
                if (result.shouldDisplay) this.host.redraw();
              }),
          );
      }),
      row("Approval", (setting) => {
        setting.setDesc("Gate every tool call from this server.").addDropdown((dropdown) =>
          dropdown
            .addOption("ask", "Ask each time")
            .addOption("allow", "Allow automatically")
            .addOption("deny", "Deny")
            .setValue(server.approval)
            .onChange(async (value) => {
              server.approval = value as ApprovalPolicy;
              this.syncMcpServerToState(server);
              await this.host.save();
            }),
        );
      }),
      row("Setup guide", (setting) => {
        const description = mcpServerSetupSteps(server)
          .map((step) => `${step.label}: ${step.status === "complete" ? "done" : step.status} - ${step.message}`)
          .join(" ");
        setting.setDesc(description).addButton((button) =>
          button.setButtonText("Copy config").onClick(async () => {
            const copied = await copyToClipboard(JSON.stringify(exportMcpServerConfig(server), null, 2));
            new Notice(copied ? `${server.name}: MCP config copied without secrets.` : `${server.name}: could not copy MCP config.`);
          }),
        );
      }),
    );

    items.push(...this.mcpAuthenticationDefinitions(server));
    items.push(...this.mcpToolFilterDefinitions(server));
    items.push(...this.mcpToolApprovalDefinitions(settings, server));
    return items;
  }

  private mcpToolFilterDefinitions(server: McpServerSettings): SettingDefinitionItem[] {
    return [
      headingRow("Tool filtering"),
      block((setting) => {
        setting.settingEl.createDiv({
          cls: "setting-item-description",
          text:
            "Ordered allow-then-deny globs for this server's native tool names (the names the MCP server " +
            "reports, not the local mcp__ names shown below). Same dialect as vault ignore: * / ** / ?. " +
            "Enabled is an allowlist (empty = allow all); disabled is a denylist (deny wins). " +
            "Up to 100 patterns, 200 characters each. Examples: * · read_* · *?_danger · tool_*",
        });
      }),
      this.toolGlobRow(
        server,
        "enabledTools",
        "Enabled tools (allowlist)",
        "One glob per line. When non-empty, only tools matching at least one pattern are exposed. Empty allows all.",
        "*\nread_*\n*_safe",
      ),
      this.toolGlobRow(
        server,
        "disabledTools",
        "Disabled tools (denylist)",
        "One glob per line. Any tool matching a disabled pattern is hidden even if it matched the allowlist.",
        "*_danger\nwrite_*\nsecret_*",
      ),
    ];
  }

  private mcpToolApprovalDefinitions(
    settings: AgenticChatSettings,
    server: McpServerSettings,
  ): SettingDefinitionItem[] {
    const items: SettingDefinitionItem[] = [
      row("Tool approvals", (setting) => {
        setting
          .setDesc("Per-tool overrides for the last discovered tools. Default follows this server's approval policy.")
          .setClass("agentic-chat-setting-heading-wrap")
          .setHeading()
          .addButton((button) =>
            button.setButtonText("Refresh tools").onClick(async () => {
              await this.refreshMcpKnownTools(server, button);
            }),
          );
      }),
    ];

    if (server.knownTools.length === 0) {
      items.push(
        block((setting) => {
          setting.settingEl.createDiv({
            cls: "setting-item-description",
            text: "No discovered tools cached yet. Use Refresh tools, Test connection, or Authenticate & test.",
          });
        }),
      );
      return items;
    }

    for (const tool of [...server.knownTools].sort((a, b) => a.name.localeCompare(b.name))) {
      const localName = mcpKnownToolLocalName(server, tool);
      const title = tool.title && tool.title !== tool.name ? `${tool.title} (${tool.name})` : tool.name;
      items.push(
        row(title, (setting) => {
          setting.setDesc(formatMcpToolApprovalDescription(localName, tool)).addDropdown((dropdown) =>
            dropdown
              .addOption("default", `Default (${server.approval})`)
              .addOption("allow", "Allow")
              .addOption("ask", "Ask")
              .addOption("deny", "Deny")
              .setValue(settings.approval.perTool[localName] ?? "default")
              .onChange(async (value) => {
                setPerToolApproval(settings.approval, localName, value as ApprovalPolicy | "default");
                await this.host.save();
              }),
          );
        }),
      );
    }
    return items;
  }

  private mcpAuthenticationDefinitions(server: McpServerSettings): SettingDefinitionItem[] {
    const authProblem = mcpAuthProblem(server);
    const items: SettingDefinitionItem[] = [
      row("Authentication", (setting) => {
        setting
          .setDesc(authProblem || "Choose how this server authenticates. Secrets are stored in Obsidian secret storage.")
          .addDropdown((dropdown) =>
            dropdown
              .addOption("none", "None")
              .addOption("bearer", "Bearer token")
              .addOption("header", "Static header")
              .addOption("oauth", "OAuth")
              .setValue(server.authType)
              .onChange(async (value) => {
                server.authType = value as McpAuthType;
                if (server.authType === "bearer") server.authHeaderName = "";
                this.syncMcpServerToState(server);
                await this.host.save();
                this.host.redraw();
              }),
          );
      }),
    ];

    if (server.authType === "oauth") {
      items.push(...this.mcpOAuthDefinitions(server));
      return items;
    }

    if (server.authType === "bearer") {
      items.push(
        this.authValueSecretDef(
          server,
          "Bearer token",
          'Paste the token only. If you include "Bearer", Agentic Chat will not add it twice.',
          "token",
        ),
      );
      return items;
    }

    if (server.authType !== "header") return items;

    items.push(
      row("Auth header", (setting) => {
        setting.setDesc("Header name sent with every MCP request.").addText((text) =>
          text
            .setPlaceholder("X-API-Key")
            .setValue(server.authHeaderName)
            .onChange(async (value) => {
              server.authHeaderName = value.trim();
              this.syncMcpServerToState(server);
              await this.host.save();
              this.host.redraw();
            }),
        );
      }),
      this.authValueSecretDef(server, "Auth value", "Header value sent with every MCP request.", "secret header value"),
    );
    return items;
  }

  private mcpOAuthDefinitions(server: McpServerSettings): SettingDefinitionItem[] {
    const authenticated = hasMcpOAuthAccess(server);
    const scopePart = server.oauth.scope ? ` with scopes: ${server.oauth.scope}` : "";
    return [
      row("OAuth status", (setting) => {
        setting
          .setDesc(
            authenticated
              ? `Authenticated${scopePart}.`
              : "Not authenticated. Use the Authenticate & test button in this server's header.",
          )
          .addButton((button) =>
            button
              .setButtonText("Forget token")
              .setDisabled(!server.oauth.accessToken && !server.oauth.refreshToken)
              .onClick(async () => {
                forgetMcpOAuthTokens(server);
                server.knownTools = [];
                this.syncMcpServerToState(server);
                await this.host.save();
                this.host.redraw();
              }),
          );
      }),
      redirectUriRow(
        "OAuth desktop redirect URI",
        "Register this localhost URI with MCP OAuth servers for Obsidian desktop sign-in.",
        DEFAULT_MCP_OAUTH_REDIRECT_URI,
        "MCP OAuth redirect URI",
      ),
      redirectUriRow(
        "OAuth mobile redirect URI",
        "Register this Obsidian URI as an additional redirect when the provider supports mobile app callbacks.",
        MCP_OAUTH_OBSIDIAN_REDIRECT_URI,
        "MCP OAuth mobile redirect URI",
      ),
      row("OAuth client id", (setting) => {
        setting
          .setDesc("Optional. Leave empty to use dynamic client registration when the server supports it.")
          .addText((text) =>
            text.setValue(server.oauth.clientId).onChange(async (value) => {
              server.oauth.clientId = value.trim();
              server.oauth.dynamicClientRegistration = false;
              server.oauth.registeredRedirectUri = "";
              this.syncMcpServerToState(server);
              await this.host.save();
            }),
          );
      }),
      this.secretInputDef({
        name: "OAuth client secret",
        desc: "Optional. Most MCP OAuth servers use public clients with PKCE and no secret.",
        placeholder: "client secret",
        hasValue: () => Boolean(server.oauth.clientSecret),
        onSet: (value) => this.setOAuthClientSecret(server, value),
        onForget: () => this.setOAuthClientSecret(server, ""),
      }),
    ];
  }

  /** One ordered glob list (allow or deny) for this server's native tool names. */
  private toolGlobRow(
    server: McpServerSettings,
    key: "enabledTools" | "disabledTools",
    name: string,
    desc: string,
    placeholder: string,
  ): SettingDefinitionRender {
    return row(name, (setting) => {
      setting.setDesc(desc).addTextArea((text) => {
        text.inputEl.rows = 3;
        text.inputEl.addClass("agentic-chat-system-prompt");
        text
          .setPlaceholder(placeholder)
          .setValue((server[key] ?? []).join("\n"))
          .onChange(async (value) => {
            const patterns = healMcpToolGlobs(
              value
                .split(/\r?\n/)
                .map((line) => line.normalize("NFC").trim())
                .filter((line) => line.length > 0 && !line.startsWith("#")),
            );
            server[key] = patterns;
            this.syncMcpServerToState(server);
            await this.host.save();
          });
      });
    });
  }

  /** The secret value for bearer and static-header auth. */
  private authValueSecretDef(
    server: McpServerSettings,
    name: string,
    desc: string,
    placeholder: string,
  ): SettingDefinitionRender {
    return this.secretInputDef({
      name,
      desc,
      placeholder,
      hasValue: () => Boolean(server.authHeaderValue),
      onSet: async (value) => {
        server.authHeaderValue = value;
        this.syncMcpServerToState(server);
        await this.host.save();
        this.host.redraw();
      },
      onForget: async () => {
        server.authHeaderValue = "";
        this.syncMcpServerToState(server);
        await this.host.save();
      },
    });
  }

  /** A manual client secret turns off dynamic registration; so does forgetting it. */
  private async setOAuthClientSecret(server: McpServerSettings, value: string): Promise<void> {
    server.oauth.clientSecret = value;
    server.oauth.dynamicClientRegistration = false;
    server.oauth.registeredRedirectUri = "";
    this.syncMcpServerToState(server);
    await this.host.save();
  }

  private async refreshMcpKnownTools(server: McpServerSettings, button?: ButtonComponent): Promise<void> {
    button?.setDisabled(true);
    try {
      const result = await this.probeAndCacheMcpTools(server);
      const sample = formatMcpToolSample(result.toolNames);
      new Notice(
        `${server.name}: refreshed ${result.toolCount} tool${result.toolCount === 1 ? "" : "s"}${sample}.`,
      );
      this.host.redraw();
    } catch (error) {
      new Notice(`Agentic chat: ${errorMessage(error)}`);
    } finally {
      button?.setDisabled(false);
    }
  }

  private async probeAndCacheMcpTools(server: McpServerSettings): Promise<Awaited<ReturnType<typeof probeMcpServer>>> {
    const endpointProblem = mcpEndpointProblem(server.url);
    if (endpointProblem) throw new Error(endpointProblem);
    const result = await probeMcpServer(server, createMcpFetcher(this.effectiveMcpProxySettings()), {
      onServerChanged: async (changed) => {
        this.syncMcpServerToState(changed);
        await this.host.save();
      },
    });
    server.knownTools = result.tools;
    server.enabled = true;
    this.syncMcpServerToState(server);
    await this.host.save();
    return result;
  }

  private async testMcpServer(server: McpServerSettings): Promise<void> {
    const result = await this.probeAndCacheMcpTools(server);
    const sample = formatMcpToolSample(result.toolNames);
    new Notice(
      `${server.name}: connected; discovered ${result.toolCount} tool${result.toolCount === 1 ? "" : "s"}${sample}.`,
    );
    this.host.redraw();
  }

  private async authenticateAndProbeMcpServer(server: McpServerSettings): Promise<void> {
    const fetcher = createMcpFetcher(this.effectiveMcpProxySettings());
    await authenticateMcpServer(server, fetcher, {
      callbackReceiver: Platform.isMobileApp ? this.host.plugin.createMcpOAuthCallbackReceiver() : undefined,
      onProgress: (event) => handleMcpOAuthProgress(server, event),
    });
    this.syncMcpServerToState(server);
    const result = await probeMcpServer(server, fetcher, {
      onServerChanged: async (changed) => {
        this.syncMcpServerToState(changed);
        await this.host.save();
      },
    });
    server.knownTools = result.tools;
    this.syncMcpServerToState(server);
    await this.host.save();
    const sample = formatMcpToolSample(result.toolNames);
    new Notice(
      `Authenticated ${server.name}; discovered ${result.toolCount} tool${
        result.toolCount === 1 ? "" : "s"
      }${sample}.`,
    );
    this.host.redraw();
  }

  private effectiveMcpProxySettings(): NetworkSettings {
    const { network, mcp } = this.host.plugin.settings;
    return effectiveProxy(mcp, network);
  }

  private async runMcpButtonAction(
    button: ButtonComponent,
    label: string,
    busyLabel: string,
    action: () => Promise<void>,
  ): Promise<void> {
    button.setDisabled(true);
    button.setButtonText(busyLabel);
    try {
      await action();
    } catch (error) {
      const msg = errorMessage(error);
      // For OAuth-required (authType none/bearer/header but server advertises resource_metadata), the client already set
      // pendingOAuthChallenge on the server. Show a banner + redraw so Authenticate & test appears without manual dropdown.
      if (msg.includes("requires OAuth") || (error as { resourceUrl?: string })?.resourceUrl) {
        new Notice(`Agentic Chat MCP: ${msg} — check the OAuth banner below.`);
        this.host.redraw();
      } else {
        new Notice(`Agentic Chat MCP: ${msg}`);
      }
    } finally {
      button.setButtonText(label);
      button.setDisabled(false);
    }
  }

  private secretInputDef(options: Parameters<typeof secretInputDef>[0]): SettingDefinitionRender {
    return secretInputDef(options, () => this.host.redraw());
  }

  private syncMcpServerToState(server: McpServerSettings): void {
    syncMcpServerToState(this.host.plugin.settings, server);
  }
}

export function handleMcpOAuthProgress(server: McpServerSettings, event: McpOAuthProgressEvent): void {
  if (event.stage === "authorization-url") {
    const authorizationUrl = event.detail ?? "";
    console.warn(
      `Agentic Chat MCP OAuth: authorization URL for ${server.name}; copy this into a browser if no tab opens: ${authorizationUrl}`,
    );
    if (authorizationUrl) {
      void copyToClipboard(authorizationUrl).then((copied) => {
        if (copied) {
          new Notice(`${server.name}: OAuth authorization URL copied. Use it if the browser does not open.`);
        } else {
          new Notice(`${server.name}: OAuth authorization URL: ${authorizationUrl}`, 0);
        }
      });
    }
    return;
  }
  if (
    event.stage === "discovery" ||
    event.stage === "registration" ||
    event.stage === "browser-open" ||
    event.stage === "callback-wait"
  ) {
    new Notice(`${server.name}: ${event.message}`);
  }
}

/** A read-only redirect URI with a Copy button; falls back to a notice that shows the URI. */
function redirectUriRow(name: string, desc: string, uri: string, label: string): SettingDefinitionRender {
  return row(name, (setting) => {
    setting
      .setDesc(desc)
      .addText((text) => text.setValue(uri).setDisabled(true))
      .addButton((button) =>
        button.setButtonText("Copy").onClick(async () => {
          if (await copyToClipboard(uri)) {
            new Notice(`${label} copied.`);
          } else {
            new Notice(`${label}: ${uri}`);
          }
        }),
      );
  });
}
