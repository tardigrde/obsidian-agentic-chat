/**
 * Jev-powered rerank for `search_memory` results (opt-in).
 *
 * Today memory search is pure lexical hand-weights (text 1.5 / tags 1.1 /
 * kind 0.8 / source 0.5, recency ≤ 0.2, confidence × 0.25) with no learned
 * relevance. A single parallel Jev `choice` call re-orders the top
 * candidates (default maxResults 8 — a natural fit for Jev's ≤255
 * cardinality) before formatting.
 *
 * Fail-soft: disabled / keyless / egress-unacknowledged / timeout /
 * malformed → original order. Never throws into the tool loop.
 */

import { queryJev, type JevTransport } from "../agent/jev-client";
import { redactText } from "../privacy/redaction";
import type { MemorySearchMatch } from "./memory";

export const JEV_RERANK_TIMEOUT_MS = 300;
export const JEV_RERANK_MAX_CANDIDATES = 8;
const MAX_OPTION_CHARS = 400;
const MAX_QUERY_CHARS = 500;
const MAX_TAGS = 5;
const MAX_TAGS_CHARS = 100;
/** Memo bounds repeat scans inside agent retry loops (per-process, TTL'd). */
const RERANK_MEMO_TTL_MS = 60_000;
const RERANK_MEMO_MAX = 200;
const rerankMemo = new Map<string, { order: number[]; confidence: number; ts: number }>();

export interface JevRerankConfig {
  enabled: boolean;
  /** Resolved by the caller (settings/secretStorage). Never logged. */
  apiKey: string;
  /**
   * Explicit acknowledgement that the query + candidate texts leave the
   * device to api.typesafe.ai. Required even when `enabled`.
   */
  allowEgress: boolean;
  /**
   * Include `vault`-scoped memories in the rerank input. Default false:
   * vault memories stay lexical-ordered (never leave the device) while
   * `global` memories may be reranked.
   */
  includeVaultScope?: boolean;
  timeoutMs?: number;
  transport?: JevTransport;
}

export interface MemoryRerankResult {
  /** Reordered matches (same objects, new order). */
  matches: MemorySearchMatch[];
  confidence: number;
  source: "jev" | "heuristic";
}

function candidateLabel(match: MemorySearchMatch): string {
  // redactText strips secret patterns + high-entropy tokens and truncates,
  // while preserving rankable prose (no content summarization here).
  const text = redactText(match.record.text, {
    maxLength: MAX_OPTION_CHARS,
    redactHighEntropy: true,
  });
  const tags = (match.record.tags ?? []).slice(0, MAX_TAGS).join(",").slice(0, MAX_TAGS_CHARS);
  const tagSuffix = tags ? ` [${tags}]` : "";
  return `${match.record.kind}${tagSuffix}: ${text}`;
}

function memoKey(query: string, matches: readonly MemorySearchMatch[]): string {
  return `${query.slice(0, 200)}|${matches.map((m) => `${m.record.id}:${m.score}`).join(",")}`;
}

export async function rerankMemoryMatches(
  query: string,
  matches: readonly MemorySearchMatch[],
  config: JevRerankConfig,
): Promise<MemoryRerankResult> {
  const identity = (): MemoryRerankResult => ({
    matches: [...matches],
    confidence: 0.5,
    source: "heuristic",
  });
  if (!config.enabled || !config.allowEgress || !config.apiKey) return identity();
  if (!Array.isArray(matches) || matches.length < 2) return identity();
  // Vault-scoped memories never leave the device unless explicitly included.
  // They keep lexical order and are appended after reranked globals.
  const includeVault = config.includeVaultScope === true;
  const eligible = matches.filter((m) => includeVault || m.record.scope !== "vault");
  const pinned = matches.filter((m) => !includeVault && m.record.scope === "vault");
  if (eligible.length < 2) return identity();
  const k = Math.min(eligible.length, JEV_RERANK_MAX_CANDIDATES);
  const key = memoKey(query, eligible);
  const cached = rerankMemo.get(key);
  if (cached && Date.now() - cached.ts < RERANK_MEMO_TTL_MS) {
    const restored = cached.order
      .map((i) => eligible[i])
      .filter((m): m is MemorySearchMatch => !!m);
    if (restored.length === eligible.length) {
      return {
        matches: [...restored, ...pinned],
        confidence: cached.confidence,
        source: "jev",
      };
    }
    rerankMemo.delete(key);
  }
  try {
    const criteria: Record<string, string> = {};
    for (let i = 0; i < k; i++) {
      const m = eligible[i];
      if (!m) return identity();
      criteria[`m${i}`] = `heur ${m.score.toFixed(2)} — ${candidateLabel(m)}`;
    }
    const safeQuery = redactText(query, { maxLength: MAX_QUERY_CHARS, redactHighEntropy: true });
    const { answers } = await queryJev(
      `query: ${safeQuery} — rank these stored memories by usefulness for answering it`,
      {
        best: {
          type: "choice",
          instructions:
            "Which stored memory is most useful for answering the query? Prefer direct answers over tangential mentions; recency and specificity beat generic advice.",
          criteria,
        },
      },
      {
        apiKey: config.apiKey,
        timeoutMs: config.timeoutMs ?? JEV_RERANK_TIMEOUT_MS,
        transport: config.transport,
      },
    );
    const ans = answers.best;
    if (!ans || ans.type !== "choice" || !ans.probabilities) return identity();
    for (let i = 0; i < k; i++) {
      if (!Number.isFinite(ans.probabilities[`m${i}`])) return identity();
    }
    const conf = Number.isFinite(ans.confidence) ? (ans.confidence as number) : 0.5;
    const order = Array.from({ length: k }, (_, i) => i).sort(
      (a, b) =>
        (ans.probabilities[`m${b}`] as number) - (ans.probabilities[`m${a}`] as number),
    );
    const ranked = order.map((i) => eligible[i] as MemorySearchMatch);
    for (let i = k; i < eligible.length; i++) ranked.push(eligible[i] as MemorySearchMatch);
    // Tail beyond top-K keeps lexical order; vault-pinned stay last, lexical.
    const finalOrder = [...ranked, ...pinned];
    const safeConf = Math.min(Math.max(conf, 0), 1);
    // Memoize eligible-relative order (pinned vault entries re-appended on hit).
    const eligibleOrder = finalOrder
      .slice(0, ranked.length)
      .map((m) => eligible.indexOf(m))
      .filter((i) => i >= 0);
    if (eligibleOrder.length === eligible.length) {
      rerankMemo.set(key, { order: eligibleOrder, confidence: safeConf, ts: Date.now() });
      if (rerankMemo.size > RERANK_MEMO_MAX) {
        const oldest = rerankMemo.keys().next();
        if (!oldest.done) rerankMemo.delete(oldest.value);
      }
    }
    return {
      matches: finalOrder,
      confidence: safeConf,
      source: "jev",
    };
  } catch {
    return identity();
  }
}
