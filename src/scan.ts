/**
 * Parser for raw card identifications transcribed from photos ("scanned
 * lines"). Deliberately more forgiving than the TCG Live decklist parser in
 * deck.ts: the quantity is optional (a photographed card is one card), set
 * tokens may be lowercase or Japanese ("m5"), and collector numbers may carry
 * the printed total ("031/084"). Pure functions — unit tested in
 * test/scan.test.ts. Classifying the set token (EN code / JP code / unknown)
 * needs the live set mapping, so that happens in scanresolve.ts.
 */

export interface ScannedLine {
  /** Original line as received, for error reporting. */
  raw: string;
  /** 1-based position in the input array. */
  index: number;
  count: number;
  /** Card name as scanned — possibly still Japanese. */
  name: string;
  /** Set token as scanned ("PBL", "pbl", "m5") — not yet classified. */
  setToken?: string;
  /** Collector number ("29", "031", "GG44"). */
  number?: string;
  /** Printed set total from an NNN/MMM number, e.g. 84 from "031/084". */
  printedTotal?: number;
}

export interface ScanParse {
  lines: ScannedLine[];
  /** Inputs that yielded no card at all (blank, or no name left after parsing). */
  skipped: { raw: string; index: number; reason: string }[];
}

/** "031/084" or "GG12/GG70": collector number plus printed total. */
const SLASH_NUMBER_RE = /^([A-Za-z]{0,4}\d{1,4}[a-z]?)\/(?:[A-Za-z]{0,4})?(\d{1,4})$/;
/** Bare collector numbers: 29, 029, 154a, GG44, TG12, SWSH284 … */
const NUMBER_RE = /^[A-Za-z]{0,4}\d{1,4}[a-z]?$/;
/** Set-code-shaped tokens, case-insensitive: PBL, pbl, sve, m5, PR-SV … */
const SET_TOKEN_RE = /^[A-Za-z][A-Za-z0-9]{0,5}(-[A-Za-z0-9]{1,4})?$/;
/** Card-name suffixes that would otherwise pass SET_TOKEN_RE ("Mega Slowbro ex 031/084"). */
const NAME_SUFFIXES = new Set(["ex", "gx", "v", "vmax", "vstar", "break", "star", "prime"]);

function isSetTokenCandidate(token: string | undefined): token is string {
  return (
    token !== undefined &&
    SET_TOKEN_RE.test(token) &&
    !/^\d+$/.test(token) &&
    !NAME_SUFFIXES.has(token.toLowerCase())
  );
}

function parseOne(raw: string, index: number): ScannedLine | { reason: string } {
  const cleaned = raw.replace(/^[\s*•\-–]+/, "").trim();
  if (cleaned === "") return { reason: "blank line" };

  let count = 1;
  let rest = cleaned;
  const qty = /^(\d{1,3})\s*[x×]\s+/.exec(cleaned) ?? /^(\d{1,3})\s+(?=\S)/.exec(cleaned);
  if (qty) {
    count = Number(qty[1]);
    rest = cleaned.slice(qty[0].length);
  }

  let tokens = rest.split(/\s+/).filter((t) => t.length > 0);
  // PTCGO-style foil marker, harmless if the client copies it over.
  if (tokens.length > 1 && tokens[tokens.length - 1] === "PH") tokens = tokens.slice(0, -1);

  let setToken: string | undefined;
  let number: string | undefined;
  let printedTotal: number | undefined;

  const last = tokens[tokens.length - 1] ?? "";
  const slash = SLASH_NUMBER_RE.exec(last);
  if (slash && tokens.length >= 2) {
    number = slash[1];
    printedTotal = Number(slash[2]);
    tokens = tokens.slice(0, -1);
    // "Slowpoke m5 028/081": a set token may still precede the number.
    const prev = tokens[tokens.length - 1];
    if (tokens.length >= 2 && isSetTokenCandidate(prev)) {
      setToken = prev;
      tokens = tokens.slice(0, -1);
    }
  } else if (tokens.length >= 3 && NUMBER_RE.test(last) && isSetTokenCandidate(tokens[tokens.length - 2])) {
    number = last;
    setToken = tokens[tokens.length - 2];
    tokens = tokens.slice(0, -2);
  } else if (tokens.length >= 2 && NUMBER_RE.test(last) && /\d/.test(last)) {
    // Trailing bare number (29, GG12, TG05), no recognizable set token before it.
    number = last;
    tokens = tokens.slice(0, -1);
  }

  const name = tokens.join(" ").trim();
  if (!name) return { reason: "no card name" };
  return { raw, index, count, name, setToken, number, printedTotal };
}

export function parseScannedLines(inputs: string[]): ScanParse {
  const lines: ScannedLine[] = [];
  const skipped: ScanParse["skipped"] = [];
  for (let i = 0; i < inputs.length; i++) {
    // A client may paste a multi-line block as one array entry — treat each
    // physical line separately (they all keep the entry's index).
    for (const piece of inputs[i].split(/\r?\n/)) {
      const parsed = parseOne(piece, i + 1);
      if ("reason" in parsed) {
        // Blank padding is dropped silently; anything with content is reported.
        if (piece.trim() !== "") skipped.push({ raw: piece, index: i + 1, reason: parsed.reason });
      } else {
        lines.push(parsed);
      }
    }
  }
  return { lines, skipped };
}
