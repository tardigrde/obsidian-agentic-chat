/** Shared shapes for the MCP OAuth flow. */

export interface OAuthProtectedResourceMetadata {
  authorization_servers?: unknown;
  scopes_supported?: unknown;
}

export interface OAuthAuthorizationServerMetadata {
  issuer?: unknown;
  authorization_endpoint?: unknown;
  token_endpoint?: unknown;
  registration_endpoint?: unknown;
  scopes_supported?: unknown;
  code_challenge_methods_supported?: unknown;
  client_id_metadata_document_supported?: unknown;
}

export interface OAuthClientRegistrationResponse {
  client_id?: unknown;
  client_secret?: unknown;
}

export interface OAuthTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  token_type?: unknown;
  expires_in?: unknown;
  scope?: unknown;
}

export interface AuthChallenge {
  resourceMetadataUrl: string;
  scope: string;
}

export interface OAuthDiscovery {
  protectedResource: OAuthProtectedResourceMetadata;
  resourceMetadataUrl: string;
  authServer: OAuthAuthorizationServerMetadata;
  authorizationServer: string;
  scope: string;
}

export interface McpOAuthDiscoverySummary {
  resourceMetadataUrl: string;
  authorizationServer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
  scopes: string[];
  codeChallengeMethods: string[];
}

export interface McpOAuthCallback {
  code: string;
  state: string;
  error?: string;
  errorDescription?: string;
}

export interface McpOAuthCallbackReceiver {
  redirectUri: string;
  /**
   * Bind this receiver to one OAuth state before the browser opens. Receivers
   * that support it refuse callbacks for another concurrent flow.
   */
  setExpectedState?(state: string): void;
  waitForCallback(expectedState: string, timeoutMs: number): Promise<McpOAuthCallback>;
  close(): void | Promise<void>;
}

export type McpOAuthProtocolParams = Record<string, string | undefined>;

export type McpOAuthProgressStage =
  | "discovery"
  | "callback"
  | "registration"
  | "authorization-url"
  | "browser-open"
  | "callback-wait"
  | "token-exchange"
  | "complete";

export interface McpOAuthProgressEvent {
  stage: McpOAuthProgressStage;
  message: string;
  detail?: string;
}

export interface McpOAuthAuthenticateOptions {
  openUrl?: (url: string) => void | Promise<void>;
  callbackReceiver?: McpOAuthCallbackReceiver;
  onProgress?: (event: McpOAuthProgressEvent) => void;
  now?: () => number;
  randomBytes?: (size: number) => Uint8Array;
  requestTimeoutMs?: number;
}
