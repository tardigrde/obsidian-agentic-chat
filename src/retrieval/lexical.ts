/** Lowercased, de-duplicated word tokens of two or more characters, in any script. */
export function tokenizeRetrievalQuery(text: string): readonly string[] {
  const matches = text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) ?? [];
  return [...new Set(matches.filter((token) => token.length >= 2))];
}
