/**
 * Jev-powered AutoMode tool-risk gating (opt-in).
 *
 * Adapts LangChain's AutoModeMiddleware
 * (https://www.langchain.com/blog/building-a-harness-with-jev and
 * https://docs.langchain.com/oss/python/integrations/providers/typesafe#tool-risk-gating):
 * classify a proposed tool call as risky BEFORE it executes, and block it
 * (return an error instead of running the tool) when confidently risky.
 *
 * How it differs from the sibling injection guard (PR #159):
 * - Injection guard asks "is this prompt injection / jailbreak?" (adversarial
 *   content) and only ever escalates allow → ask.
 * - AutoMode asks "is this action risky or insufficiently authorized?"
 *   (destructive, irreversible, exfiltrating, secret-touching, or beyond
 *   apparent intent) and BLOCKS in `block` mode, or escalates in `escalate`
 *   mode. Pair `block` with human-in-the-loop approval for the rest, per
 *   LangChain's warning.
 *
 * Fail-open everywhere except confident-risky: disabled / keyless /
 * egress-unacknowledged / unlisted tool / timeout / malformed /
 * low-confidence → allow (null). Never throws into the gate.
 */

import { queryJev, type JevTransport } from "./jev-client";
import { redactValue } from "../privacy/redaction";

export const JEV_AUTOMODE_TIMEOUT_MS = 300;
/** Block/escalation threshold. Miscalibration costs friction, not safety. */
export const JEV_AUTOMODE_MIN_CONFIDENCE = 0.8;
const MAX_STATE_CHARS = 2000;
export const JEV_AUTOMODE_CACHE_TTL_MS = 60_000;
export const JEV_AUTOMODE_CACHE_MAX = 200;
export const JEV_AUTOMODE_MAX_SCANS = 300;

/** Short stable preview for memo keys. */
export function safePreview(value: unknown, maxChars = 1000): string {
  try {
    const json = JSON.stringify(value) ?? "null";
    return json.length > maxChars ? json.slice(0, maxChars) : json;
  } catch {
    return "[unserializable]";
  }
}

/**
 * Default gated tools: irreversible or persistence-changing vault tools, plus
 * all MCP tools (`mcp__*`, third-party code, matched by prefix).
 *
 * Deliberately NOT gated by default: `write` / `edit` (reversible via undo
 * + already ask-gated in Safe mode — see the working-dir boundary), `read`
 * and other pure reads, `fetch_url` / `web_search` (covered by the sibling
 * injection guard's risky-read set). Users can extend via settings `tools`.
 * Pinned by test (`write`/`edit` explicitly unscanned).
 */
export const JEV_AUTOMODE_DEFAULT_TOOLS: readonly string[] = [
  "delete",
  "rename",
  "create_skill",
  "load_skill",
  "unload_skill",
];

export type JevAutoMode = "block" | "escalate";

export interface JevAutoModeConfig {
  enabled: boolean;
  /** Resolved by the caller (settings/secretStorage). Never logged. */
  apiKey: string;
  /**
   * Explicit acknowledgement that redacted tool args leave the device to
   * api.typesafe.ai. Required even when `enabled`.
   */
  allowEgress: boolean;
  /** block: refuse risky calls; escalate: route them to ask. Default block. */
  mode?: JevAutoMode;
  /** Extra tool names to gate (beyond defaults + mcp__*). */
  tools?: readonly string[];
  timeoutMs?: number;
  minConfidence?: number;
  transport?: JevTransport;
}

export interface ToolRiskAssessment {
  risky: boolean;
  confidence: number;
  source: "jev" | "heuristic";
}

/** True when this tool is covered by AutoMode gating. */
export function isAutoModeGatedTool(toolName: string, extraTools?: readonly string[]): boolean {
  if (toolName.startsWith("mcp__")) return true;
  if ((JEV_AUTOMODE_DEFAULT_TOOLS as readonly string[]).includes(toolName)) return true;
  return !!extraTools?.includes(toolName);
}

/** Compact inspected state: tool name + redacted, truncated args. */
export function buildRiskState(toolName: string, args: unknown): string {
  let argText: string;
  try {
    // Content visible by design (risk lives in targets/payloads); secret
    // patterns + high-entropy tokens still redacted. Callers must gate on
    // explicit egress acknowledgement.
    const redacted = redactValue(args, {
      maxLength: 800,
      maxArrayLength: 10,
      maxObjectKeys: 15,
      maxDepth: 3,
      summarizeContent: false,
      redactHighEntropy: true,
    });
    argText = JSON.stringify(redacted) ?? "null";
  } catch {
    argText = "[unserializable args]";
  }
  const state = `tool:${toolName} args:${argText}`;
  return state.length > MAX_STATE_CHARS ? `${state.slice(0, MAX_STATE_CHARS)}...[truncated]` : state;
}

function clamp01(raw: number | undefined, fallback: number): number {
  if (!Number.isFinite(raw as number)) return fallback;
  return Math.min(Math.max(raw as number, 0), 1);
}

/**
 * Assess a proposed tool call. Never throws — every failure path returns
 * `{ risky: false, source: "heuristic" }` (fail-open) except a confident
 * Jev risky verdict.
 */
export async function assessToolRisk(
  toolName: string,
  args: unknown,
  config: JevAutoModeConfig,
): Promise<ToolRiskAssessment> {
  const safe = (): ToolRiskAssessment => ({ risky: false, confidence: 0.5, source: "heuristic" });
  if (!config.enabled || !config.allowEgress || !config.apiKey) return safe();
  if (!isAutoModeGatedTool(toolName, config.tools)) return safe();
  const minConfidence = clamp01(config.minConfidence ?? JEV_AUTOMODE_MIN_CONFIDENCE, JEV_AUTOMODE_MIN_CONFIDENCE);
  try {
    const { answers } = await queryJev(
      buildRiskState(toolName, args),
      {
        risky: {
          type: "noul",
          instructions:
            "This tool call is risky or insufficiently authorized: destructive or irreversible (deletes, irreversible renames, wiping folders), sends vault data to third parties (untrusted MCP servers, skill installs from untrusted sources), touches secrets or credentials, persists untrusted third-party code, or is far out of proportion to routine vault work (e.g. mass deletion). Routine reads, user-requested single-file writes, and reversible operations are NOT risky. True means block-worthy risky.",
        },
      },
      {
        apiKey: config.apiKey,
        timeoutMs: config.timeoutMs ?? JEV_AUTOMODE_TIMEOUT_MS,
        transport: config.transport,
      },
    );
    const ans = answers.risky;
    if (!ans || ans.type !== "noul" || !Number.isFinite(ans.noul)) return safe();
    const p = ans.noul;
    if (p < 0 || p > 1) return safe();
    if (p < minConfidence) return safe();
    return { risky: true, confidence: p, source: "jev" };
  } catch {
    return safe();
  }
}
