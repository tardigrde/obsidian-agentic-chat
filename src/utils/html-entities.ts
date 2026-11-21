/**
 * Decode HTML character references in text that came from a web page or a
 * search API snippet. Numeric references decode in full; named ones cover the
 * HTML 4 set that pages use in prose (U4 #15: `&sect;` stayed raw). Unknown
 * names stay as they are.
 */
const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  iexcl: "¡", cent: "¢", pound: "£", curren: "¤", yen: "¥", brvbar: "¦", sect: "§", uml: "¨", copy: "©",
  ordf: "ª", laquo: "«", not: "¬", shy: "", reg: "®", macr: "¯", deg: "°", plusmn: "±", sup2: "²",
  sup3: "³", acute: "´", micro: "µ", para: "¶", middot: "·", cedil: "¸", sup1: "¹", ordm: "º", raquo: "»",
  frac14: "¼", frac12: "½", frac34: "¾", iquest: "¿", times: "×", divide: "÷",
  Agrave: "À", Aacute: "Á", Acirc: "Â", Atilde: "Ã", Auml: "Ä", Aring: "Å", AElig: "Æ", Ccedil: "Ç",
  Egrave: "È", Eacute: "É", Ecirc: "Ê", Euml: "Ë", Igrave: "Ì", Iacute: "Í", Icirc: "Î", Iuml: "Ï",
  ETH: "Ð", Ntilde: "Ñ", Ograve: "Ò", Oacute: "Ó", Ocirc: "Ô", Otilde: "Õ", Ouml: "Ö", Oslash: "Ø",
  Ugrave: "Ù", Uacute: "Ú", Ucirc: "Û", Uuml: "Ü", Yacute: "Ý", THORN: "Þ", szlig: "ß",
  agrave: "à", aacute: "á", acirc: "â", atilde: "ã", auml: "ä", aring: "å", aelig: "æ", ccedil: "ç",
  egrave: "è", eacute: "é", ecirc: "ê", euml: "ë", igrave: "ì", iacute: "í", icirc: "î", iuml: "ï",
  eth: "ð", ntilde: "ñ", ograve: "ò", oacute: "ó", ocirc: "ô", otilde: "õ", ouml: "ö", oslash: "ø",
  ugrave: "ù", uacute: "ú", ucirc: "û", uuml: "ü", yacute: "ý", thorn: "þ", yuml: "ÿ",
  OElig: "Œ", oelig: "œ", Scaron: "Š", scaron: "š", Yuml: "Ÿ", fnof: "ƒ", circ: "ˆ", tilde: "˜",
  ensp: " ", emsp: " ", thinsp: " ", zwnj: "", zwj: "", lrm: "", rlm: "",
  ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", sbquo: "‚", ldquo: "“", rdquo: "”", bdquo: "„",
  dagger: "†", Dagger: "‡", bull: "•", hellip: "…", permil: "‰", prime: "′", Prime: "″",
  lsaquo: "‹", rsaquo: "›", oline: "‾", frasl: "⁄", euro: "€", trade: "™", larr: "←", uarr: "↑",
  rarr: "→", darr: "↓", harr: "↔", minus: "−", le: "≤", ge: "≥", ne: "≠", asymp: "≈", infin: "∞",
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", pi: "π", sigma: "σ", mu: "μ", lambda: "λ", Omega: "Ω",
};

export function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, code: string) => {
    if (code.startsWith("#")) {
      const hex = code[1] === "x" || code[1] === "X";
      const num = hex ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(num) && num > 0 && num <= 0x10ffff ? String.fromCodePoint(num) : match;
    }
    return NAMED[code] ?? NAMED[code.toLowerCase()] ?? match;
  });
}

/** Search snippets arrive with highlight markup (`<strong>`): plain text only. */
export function plainTextFromHtml(input: string): string {
  // Decode first, then strip until nothing changes: an encoded tag
  // (`&lt;img onerror=…&gt;`) or a nested one (`<scr<b>ipt>`) never survives.
  let text = decodeHtmlEntities(input);
  let previous: string;
  do {
    previous = text;
    text = text.replace(/<[^>]*>/g, "");
  } while (text !== previous);
  return text.replace(/\s+/g, " ").trim();
}
