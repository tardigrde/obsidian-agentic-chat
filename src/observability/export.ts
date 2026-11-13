import type { WebFetcher } from "../tools/web-fetch";
import { errorMessage } from "../utils/errors";
import { exportOtlpSpans, OtlpExportError } from "./otlp";
import { toOtlpSpans, type ActiveTrace } from "./spans";

export interface ObservabilityExportHealth {
  attemptedExports: number;
  successfulExports: number;
  failedExports: number;
  droppedTraces: number;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  lastStatus: number | null;
  lastSpanCount: number | null;
}

export interface SpanExporterOptions {
  fetcher: WebFetcher;
  now: () => number;
}

/** Owns OTLP export and the health counters surfaced by diagnostics. */
export class SpanExporter {
  private readonly health: ObservabilityExportHealth = {
    attemptedExports: 0,
    successfulExports: 0,
    failedExports: 0,
    droppedTraces: 0,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastErrorAt: null,
    lastError: null,
    lastStatus: null,
    lastSpanCount: null,
  };

  constructor(private readonly options: SpanExporterOptions) {}

  getHealth(): ObservabilityExportHealth {
    return { ...this.health };
  }

  recordDroppedTrace(): void {
    this.health.droppedTraces += 1;
  }

  async export(trace: ActiveTrace): Promise<void> {
    const spans = toOtlpSpans(trace, this.options.now());
    this.recordExportAttempt(spans.length);
    try {
      const result = await exportOtlpSpans(
        {
          settings: trace.settings,
          serviceName: "agentic-chat",
          spans,
        },
        this.options.fetcher,
      );
      this.recordExportSuccess(result?.status ?? null);
    } catch (error) {
      this.recordExportFailure(error);
      throw error;
    }
  }

  private recordExportAttempt(spanCount: number): void {
    this.health.attemptedExports += 1;
    this.health.lastAttemptAt = new Date(this.options.now()).toISOString();
    this.health.lastSpanCount = spanCount;
  }

  private recordExportSuccess(status: number | null): void {
    this.health.successfulExports += 1;
    this.health.lastSuccessAt = new Date(this.options.now()).toISOString();
    this.health.lastStatus = status;
    this.health.lastError = null;
    this.health.lastErrorAt = null;
  }

  private recordExportFailure(error: unknown): void {
    this.health.failedExports += 1;
    this.health.lastErrorAt = new Date(this.options.now()).toISOString();
    this.health.lastError = errorMessage(error);
    this.health.lastStatus = error instanceof OtlpExportError ? error.status : null;
  }
}
