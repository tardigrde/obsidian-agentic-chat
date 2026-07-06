import type { WebFetcher, WebHttpRequest } from "../tools/web-fetch";
import { assertValidHttpHeaderName, assertValidHttpHeaderValue } from "../mcp/http-headers";
import {
  normalizeLangfuseOtlpTraceEndpoint,
  type ObservabilitySettings,
} from "./settings";

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes?: Record<string, OtlpAttributeValue>;
  status?: {
    code: "ok" | "error" | "unset";
    message?: string;
  };
}

export type OtlpAttributeValue = string | number | boolean | string[] | number[] | boolean[];

export interface OtlpExportInput {
  settings: ObservabilitySettings;
  spans: readonly OtlpSpan[];
  serviceName?: string;
  serviceVersion?: string;
}

export interface OtlpExportResult {
  status: number;
}

export class OtlpExportError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "OtlpExportError";
  }
}

export async function exportOtlpSpans(input: OtlpExportInput, fetcher: WebFetcher): Promise<OtlpExportResult | null> {
  if (!input.settings.enabled || input.spans.length === 0) return null;
  const request = buildOtlpTraceRequest(input);
  const response = await fetcher(request);
  if (response.status === 0) throw new OtlpExportError(`Observability export failed: ${response.text || "network error"}.`, response.status);
  if (response.status < 200 || response.status >= 300) {
    throw new OtlpExportError(`Observability export failed (HTTP ${response.status}).`, response.status);
  }
  return { status: response.status };
}

export function buildOtlpTraceRequest(input: OtlpExportInput): WebHttpRequest {
  const endpoint = observabilityTraceEndpoint(input.settings);
  if (!endpoint) throw new Error("Observability endpoint is required.");

  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...observabilityAuthHeaders(input.settings),
  };

  return {
    url: endpoint,
    method: "POST",
    headers,
    body: JSON.stringify(buildOtlpTraceBody(input)),
  };
}

export function observabilityTraceEndpoint(settings: ObservabilitySettings): string {
  if (settings.backend === "langfuse") return normalizeLangfuseOtlpTraceEndpoint(settings.endpoint);
  return settings.endpoint.trim();
}

export function observabilityAuthHeaders(settings: ObservabilitySettings): Record<string, string> {
  if (settings.backend === "langfuse") {
    const publicKey = settings.langfusePublicKey.trim();
    const secretKey = settings.langfuseSecretKey.trim();
    if (!publicKey || !secretKey) return {};
    return {
      Authorization: `Basic ${base64Encode(`${publicKey}:${secretKey}`)}`,
      "x-langfuse-ingestion-version": "4",
    };
  }
  const headerName = settings.authHeaderName.trim();
  const headerValue = settings.authHeaderValue.trim();
  if (!headerName || !headerValue) return {};
  return {
    [assertValidHttpHeaderName(headerName)]: assertValidHttpHeaderValue(headerValue),
  };
}

function buildOtlpTraceBody(input: OtlpExportInput): unknown {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: attributesFromRecord({
            "service.name": input.serviceName ?? "agentic-chat",
            "service.version": input.serviceVersion ?? "",
          }),
        },
        scopeSpans: [
          {
            scope: {
              name: "agentic-chat.observability",
              version: input.serviceVersion ?? "",
            },
            spans: input.spans.map(otlpSpanToJson),
          },
        ],
      },
    ],
  };
}

function otlpSpanToJson(span: OtlpSpan): unknown {
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId,
    name: span.name,
    kind: 1,
    startTimeUnixNano: span.startTimeUnixNano,
    endTimeUnixNano: span.endTimeUnixNano,
    attributes: attributesFromRecord(span.attributes ?? {}),
    status: statusToJson(span.status),
  };
}

function attributesFromRecord(record: Record<string, OtlpAttributeValue>): unknown[] {
  return Object.entries(record)
    .filter(([, value]) => value !== "" && value !== undefined)
    .map(([key, value]) => ({ key, value: anyValue(value) }));
}

function anyValue(value: OtlpAttributeValue): unknown {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  return { arrayValue: { values: value.map(anyValue) } };
}

function statusToJson(status: OtlpSpan["status"]): unknown {
  if (!status || status.code === "unset") return { code: 0 };
  if (status.code === "ok") return { code: 1 };
  return { code: 2, message: status.message ?? "" };
}

function base64Encode(value: string): string {
  if (typeof window.btoa !== "function") {
    throw new Error("This platform cannot encode Langfuse credentials for Basic auth.");
  }
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return window.btoa(binary);
}
