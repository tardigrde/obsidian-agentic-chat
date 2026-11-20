/** Ctrl+W alone (no Shift, Alt, or Meta); on macOS Ctrl+W is left to the system. */
export function isDeleteWordKey(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "isComposing">,
  isMacOS: boolean,
): boolean {
  if (isMacOS || event.isComposing) return false;
  return event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "w";
}

/**
 * Delete the word before the caret (or the selection), like Ctrl+W in a
 * terminal: trailing spaces first, then the run of non-space characters.
 * Fires an `input` event so the composer state follows.
 */
export function deletePreviousWord(input: HTMLTextAreaElement): void {
  const value = input.value;
  const end = input.selectionEnd ?? value.length;
  let start = input.selectionStart ?? end;
  if (start === end) {
    while (start > 0 && /\s/.test(value[start - 1])) start -= 1;
    while (start > 0 && !/\s/.test(value[start - 1])) start -= 1;
  }
  if (start === end) return;
  input.setRangeText("", start, end, "end");
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
