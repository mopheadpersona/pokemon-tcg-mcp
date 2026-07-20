/**
 * Parser for TCG Live / PTCGO decklist exports. Pure functions — unit tested
 * in test/deck.test.ts.
 *
 * Typical input:
 *   Pokémon: 12
 *   4 Slowpoke PBL 29
 *   ...
 *   Trainer: 35
 *   4 Jacinthe POR 75
 *   ...
 *   Energy: 13
 *   13 Basic {P} Energy SVE 13
 *   Total Cards: 60
 */

export interface DeckEntry {
  count: number;
  name: string;
  setCode?: string;
  number?: string;
  line: number;
  raw: string;
}

export interface ParsedDeck {
  entries: DeckEntry[];
  /** Sum of entry counts. */
  totalCards: number;
  /** The "Total Cards: N" value from the export, if present. */
  declaredTotal?: number;
  warnings: string[];
}

const SECTION_RE = /^(pok[eé]mon|trainers?|energy|energies)\b\s*[:：]?\s*\(?\d*\)?\s*$/i;
const TOTAL_RE = /^total\s+cards?\s*[:：]?\s*(\d+)\s*$/i;
const CARD_LINE_RE = /^(\d{1,3})\s*[x×]?\s+(.+)$/;
/** Card numbers: 29, 029, 154a, GG44, TG12, SWSH284 … */
const NUMBER_RE = /^[A-Za-z]{0,4}\d{1,4}[a-z]?$/;
/** Set codes: PBL, SVE, CRZ, PR-SV … */
const SETCODE_RE = /^[A-Z][A-Z0-9]{1,5}(-[A-Z0-9]{1,4})?$/;

const ENERGY_SHORTHAND: Record<string, string> = {
  G: "Grass",
  R: "Fire",
  W: "Water",
  L: "Lightning",
  P: "Psychic",
  F: "Fighting",
  D: "Darkness",
  M: "Metal",
  Y: "Fairy",
  N: "Dragon",
  C: "Colorless",
};

function expandEnergyShorthand(name: string): string {
  return name.replace(/\{([A-Z])\}/g, (match, letter: string) => ENERGY_SHORTHAND[letter] ?? match);
}

export function parseDecklist(text: string): ParsedDeck {
  const entries: DeckEntry[] = [];
  const warnings: string[] = [];
  let declaredTotal: number | undefined;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/^[\s*•-]+/, "").trim();
    if (!line) continue;
    if (SECTION_RE.test(line)) continue;
    const totalMatch = TOTAL_RE.exec(line);
    if (totalMatch) {
      declaredTotal = Number(totalMatch[1]);
      continue;
    }

    const cardMatch = CARD_LINE_RE.exec(line);
    if (!cardMatch) {
      warnings.push(`Line ${i + 1} ignored (not a card line): "${line}"`);
      continue;
    }

    const count = Number(cardMatch[1]);
    let tokens = cardMatch[2].trim().split(/\s+/);
    // PTCGO exports sometimes append a foil marker.
    if (tokens.length > 1 && tokens[tokens.length - 1] === "PH") tokens = tokens.slice(0, -1);

    let setCode: string | undefined;
    let number: string | undefined;
    if (
      tokens.length >= 4 &&
      NUMBER_RE.test(tokens[tokens.length - 1]) &&
      /^energy$/i.test(tokens[tokens.length - 2]) &&
      /^energy$/i.test(tokens[tokens.length - 3])
    ) {
      // PTCGO basic energy lines use the pseudo set "Energy" ("6 Psychic Energy Energy 5")
      // whose numbers don't exist on pokemontcg.io — resolve by name instead.
      tokens = tokens.slice(0, -2);
    } else if (tokens.length >= 3 && NUMBER_RE.test(tokens[tokens.length - 1]) && SETCODE_RE.test(tokens[tokens.length - 2])) {
      number = tokens[tokens.length - 1];
      setCode = tokens[tokens.length - 2].toUpperCase();
      tokens = tokens.slice(0, -2);
    } else if (tokens.length >= 2 && /^\d{1,4}$/.test(tokens[tokens.length - 1])) {
      // Bare trailing number with no recognizable set code.
      number = tokens[tokens.length - 1];
      tokens = tokens.slice(0, -1);
      warnings.push(`Line ${i + 1}: no set code before number ${number} — will resolve "${tokens.join(" ")}" by name.`);
    }

    const name = expandEnergyShorthand(tokens.join(" ").trim());
    if (!name) {
      warnings.push(`Line ${i + 1} ignored (no card name): "${line}"`);
      continue;
    }
    entries.push({ count, name, setCode, number, line: i + 1, raw: line });
  }

  const totalCards = entries.reduce((sum, e) => sum + e.count, 0);
  if (declaredTotal !== undefined && declaredTotal !== totalCards) {
    warnings.push(`Export says "Total Cards: ${declaredTotal}" but parsed counts sum to ${totalCards}.`);
  }
  return { entries, totalCards, declaredTotal, warnings };
}

export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Normalize a card number for matching: uppercase, strip leading zeros ("029" ≡ "29", "gg44" ≡ "GG44"). */
export function normNum(num: string): string {
  return num.toUpperCase().replace(/^0+(?=\d)/, "");
}

/** Aggregate copy counts by card name across printings ("4 Iono PAL 185" + "1 Iono PAF 80" → 5). */
export function countByName(entries: DeckEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const key = normalizeName(entry.name);
    counts.set(key, (counts.get(key) ?? 0) + entry.count);
  }
  return counts;
}

/** Fallback basic-energy detection for entries the API couldn't resolve. */
export function looksLikeBasicEnergy(name: string): boolean {
  return /^basic\s+(grass|fire|water|lightning|psychic|fighting|darkness|metal|fairy)\s+energy$/i.test(name.trim())
    || /^(grass|fire|water|lightning|psychic|fighting|darkness|metal|fairy)\s+energy$/i.test(name.trim());
}
