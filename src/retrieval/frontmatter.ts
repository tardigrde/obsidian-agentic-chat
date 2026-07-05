export function formatFrontmatterScalar(value: string): string {
  return JSON.stringify(value.replace(/\r?\n/g, " ").trim());
}

export function parseFrontmatterFields(text: string): Map<string, string> | null {
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!frontmatter) return null;
  const fields = new Map<string, string>();
  for (const line of frontmatter[1].split("\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();
    fields.set(key, parseFrontmatterScalar(rawValue));
  }
  return fields;
}

function parseFrontmatterScalar(value: string): string {
  if (value.startsWith("\"") && value.endsWith("\"")) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (typeof parsed === "string") return parsed;
    } catch {
      return value;
    }
  }
  return value;
}
