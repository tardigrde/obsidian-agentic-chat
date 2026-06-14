/**
 * Resolve data dropped onto the chat pane into a vault-relative path.
 *
 * Obsidian represents a dragged note as an `obsidian://open?vault=…&file=…` URL;
 * left to bubble, the drop *opens* the note. We intercept it and turn it into a
 * chat attachment instead. Returns null when the data isn't a usable vault path
 * (a foreign-vault link, an unknown URL scheme, or empty), so the caller can let
 * the event fall through to Obsidian's default handling.
 */
export function parseDroppedVaultPath(data: string, vaultName: string): string | null {
  // A multi-file drag yields newline-separated entries; take the first one so a
  // multi-line string doesn't make `new URL()` throw and fail the whole drop.
  const trimmed = data.split(/[\r\n]+/)[0]?.trim() ?? "";
  if (!trimmed) return null;

  if (trimmed.startsWith("obsidian://")) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return null;
    }
    // URLSearchParams returns already-decoded values; don't decode again.
    const file = url.searchParams.get("file");
    if (!file) return null;
    const vault = url.searchParams.get("vault");
    if (vault && vault !== vaultName) return null;
    return file;
  }

  // Reject any other URL scheme (http(s), app://, file://) — only a bare
  // vault-relative path is meaningful as an attachment.
  if (/^[a-z][\w+.-]*:\/\//i.test(trimmed)) return null;
  return trimmed;
}
