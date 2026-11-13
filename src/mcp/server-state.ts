import { clearMcpPerToolApprovals, type ApprovalSettings } from "../agent/approval";
import { mcpServerStateFromServer, type McpServerSettings, type McpServerState } from "./settings";

/**
 * The one rule for client-owned MCP state: what must not survive a server move
 * to a new URL (or a package rename). Tokens, static credentials, discovered
 * tools, and a pending OAuth challenge were minted for the old host.
 */
export interface McpAuthClearable {
  authHeaderValue: string;
  oauth: { accessToken: string; refreshToken: string; expiresAt: number };
  knownTools: unknown[];
  pendingOAuthChallenge?: string;
  pendingOAuthResourceUrl?: string;
}

/** Mutate `state` in place: drop everything bound to the previous endpoint. */
export function clearAuthForUrlChange<T extends McpAuthClearable>(state: T): T {
  state.authHeaderValue = "";
  state.oauth = { ...state.oauth, accessToken: "", refreshToken: "", expiresAt: 0 };
  state.knownTools = [];
  state.pendingOAuthChallenge = undefined;
  state.pendingOAuthResourceUrl = undefined;
  return state;
}

/** Copy the server's client-owned fields onto its persisted state record. */
export function syncMcpServerState(state: McpServerState, server: McpServerSettings): void {
  const next = mcpServerStateFromServer(server);
  Object.assign(state, next);
  if (next.lastUrl) state.lastUrl = next.lastUrl;
  else delete state.lastUrl;
}

/** Settings slice needed to prune MCP state: the state map and its approvals. */
export interface McpStatePruneTarget {
  plugins: { mcpState: Record<string, McpServerState> };
  approval: ApprovalSettings;
}

/**
 * The one prune rule: drop state (and its per-tool approvals) for ids no live
 * server owns. `keep` protects ids that another owner still uses, such as a
 * retained import backup or a legacy user server. Returns true when it changed
 * settings, so the caller saves only on a real mutation.
 */
export function pruneMcpState(
  target: McpStatePruneTarget,
  aliveIds: ReadonlySet<string> | readonly string[],
  keep: (id: string) => boolean = () => false,
): boolean {
  const alive = aliveIds instanceof Set ? aliveIds : new Set(aliveIds);
  let mutated = false;
  for (const id of Object.keys(target.plugins.mcpState)) {
    if (alive.has(id) || keep(id)) continue;
    delete target.plugins.mcpState[id];
    clearMcpPerToolApprovals(target.approval, id);
    mutated = true;
  }
  return mutated;
}
