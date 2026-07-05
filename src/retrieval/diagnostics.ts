import type {
  LexicalRetrievalSignalMatch,
  LexicalVaultQaResponse,
  LexicalVaultQaResult,
} from "./lexical";
import type { RetrievalLanguagePolicy } from "./policy";

export interface RetrievalRankingControls {
  pinnedPaths?: readonly string[];
  excludedPaths?: readonly string[];
}

export interface RetrievalScoreComponent {
  kind: LexicalRetrievalSignalMatch["kind"];
  score: number;
  detail: string;
  matches: readonly string[];
}

export interface RetrievalControlState {
  pinned: boolean;
  excluded: boolean;
  moreLikeThisAvailable: boolean;
}

export interface MoreLikeThisSeed {
  documentId: string;
  path: string;
  title: string;
  language?: string;
  tags: readonly string[];
  aliases: readonly string[];
  links: readonly string[];
  backlinks: readonly string[];
}

export interface RetrievalResultDiagnostic {
  rank: number;
  documentId: string;
  path: string;
  title: string;
  score: number;
  why: readonly string[];
  scoreComponents: readonly RetrievalScoreComponent[];
  controlState: RetrievalControlState;
  moreLikeThis: MoreLikeThisSeed;
}

export interface RetrievalDiagnosticsBundle {
  queryTokens: readonly string[];
  totalMatches: number;
  ignoredCount: number;
  languageMode?: RetrievalLanguagePolicy["mode"];
  languageLimitations: readonly string[];
  results: readonly RetrievalResultDiagnostic[];
}

export function applyRetrievalRankingControls(
  results: readonly LexicalVaultQaResult[],
  controls: RetrievalRankingControls = {},
): readonly LexicalVaultQaResult[] {
  const excluded = normalizedPathSet(controls.excludedPaths);
  const pinned = normalizedPathList(controls.pinnedPaths);
  const pinnedOrder = new Map(pinned.map((path, index) => [path, index]));

  return results
    .filter((result) => !excluded.has(normalizePath(result.document.path)))
    .map((result, originalIndex) => ({ result, originalIndex }))
    .sort((left, right) => {
      const leftPin = pinnedOrder.get(normalizePath(left.result.document.path));
      const rightPin = pinnedOrder.get(normalizePath(right.result.document.path));
      if (leftPin !== undefined || rightPin !== undefined) {
        if (leftPin === undefined) return 1;
        if (rightPin === undefined) return -1;
        return leftPin - rightPin;
      }
      if (right.result.score !== left.result.score) return right.result.score - left.result.score;
      return left.originalIndex - right.originalIndex;
    })
    .map((entry) => entry.result);
}

export function buildRetrievalDiagnostics(
  response: LexicalVaultQaResponse,
  options: {
    controls?: RetrievalRankingControls;
    languagePolicy?: RetrievalLanguagePolicy;
  } = {},
): RetrievalDiagnosticsBundle {
  const controlled = applyRetrievalRankingControls(response.results, options.controls);
  const pinned = normalizedPathSet(options.controls?.pinnedPaths);

  return {
    queryTokens: response.queryTokens,
    totalMatches: response.totalMatches,
    ignoredCount: response.ignoredCount,
    languageMode: options.languagePolicy?.mode,
    languageLimitations: options.languagePolicy?.limitationMessages ?? [],
    results: controlled.map((result, index) => ({
      rank: index + 1,
      documentId: result.document.id,
      path: result.document.path,
      title: result.document.title,
      score: result.score,
      why: result.signals.map(explainSignal),
      scoreComponents: result.signals.map((signal) => ({
        kind: signal.kind,
        score: signal.score,
        detail: signal.detail,
        matches: signal.matches,
      })),
      controlState: {
        pinned: pinned.has(normalizePath(result.document.path)),
        excluded: false,
        moreLikeThisAvailable: true,
      },
      moreLikeThis: {
        documentId: result.document.id,
        path: result.document.path,
        title: result.document.title,
        language: result.document.language,
        tags: result.document.tags ?? [],
        aliases: result.document.aliases ?? [],
        links: result.document.links ?? [],
        backlinks: result.document.backlinks ?? [],
      },
    })),
  };
}

export function serializeRetrievalDiagnostics(bundle: RetrievalDiagnosticsBundle): string {
  return JSON.stringify(bundle, null, 2);
}

export function parseRetrievalDiagnostics(text: string): RetrievalDiagnosticsBundle {
  const parsed = JSON.parse(text) as RetrievalDiagnosticsBundle;
  return parsed;
}

function explainSignal(signal: LexicalRetrievalSignalMatch): string {
  const matches = signal.matches.length > 0 ? `: ${signal.matches.join(", ")}` : "";
  return `Matched ${signal.detail}${matches} (+${signal.score})`;
}

function normalizedPathSet(paths: readonly string[] | undefined): Set<string> {
  return new Set(normalizedPathList(paths));
}

function normalizedPathList(paths: readonly string[] | undefined): string[] {
  return (paths ?? []).map(normalizePath);
}

function normalizePath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+/g, "/").toLowerCase();
}
