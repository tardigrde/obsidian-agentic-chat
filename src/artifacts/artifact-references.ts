import type { AgentMessage } from "@earendil-works/pi-agent-core";

const ARTIFACT_REFERENCE = /\bartifact:([A-Za-z0-9_-]+)/g;

export function collectArtifactIdsFromMessages(messages: readonly AgentMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    for (const id of collectArtifactIdsFromMessage(message)) ids.add(id);
  }
  return ids;
}

export function collectArtifactIdsFromMessage(message: AgentMessage): Set<string> {
  const ids = collectArtifactIdsFromText(messageContentText(message));
  const record = message as unknown as Record<string, unknown>;
  const details = objectValue(record.details);
  addString(ids, details?.sourceArtifactId);
  addString(ids, details?.artifactId);

  const manifest = objectValue(record.compactionManifest);
  for (const artifact of arrayValue(manifest?.artifacts)) {
    addString(ids, objectValue(artifact)?.id);
  }
  for (const entry of arrayValue(manifest?.externalInspect)) {
    addString(ids, objectValue(entry)?.sourceArtifactId);
  }
  return ids;
}

export function collectArtifactIdsFromText(text: string): Set<string> {
  const ids = new Set<string>();
  for (const match of text.matchAll(ARTIFACT_REFERENCE)) ids.add(match[1]);
  return ids;
}

function messageContentText(message: AgentMessage): string {
  const content = (message as unknown as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const record = objectValue(part);
      return record?.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function arrayValue(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function addString(ids: Set<string>, value: unknown): void {
  if (typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value)) ids.add(value);
}
