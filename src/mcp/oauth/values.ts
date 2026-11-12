import { errorMessage } from "../../utils/errors";

export function parseJsonObject<T>(text: string, label: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text || "{}");
  } catch (error) {
    throw new Error(`${label} was not valid JSON: ${errorMessage(error)}.`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} was not a JSON object.`);
  }
  return parsed as T;
}

export function firstString(value: unknown): string {
  if (Array.isArray(value)) return stringValue(value.find((item) => typeof item === "string"));
  return stringValue(value);
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function finitePositiveNumber(value: unknown): number {
  let parsed: number;
  if (typeof value === "number") {
    parsed = value;
  } else if (typeof value === "string") {
    parsed = Number.parseFloat(value);
  } else {
    parsed = 0;
  }
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function normalizeHttpsUrl(input: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    throw new Error(`Invalid MCP OAuth URL: ${input}`);
  }
  if (parsed.protocol !== "https:") throw new Error(`MCP OAuth URLs must use https: ${input}`);
  return parsed;
}
