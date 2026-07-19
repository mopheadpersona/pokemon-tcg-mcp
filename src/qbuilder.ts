/**
 * Builders for pokemontcg.io's Lucene-style `q` parameter. Pure functions —
 * unit tested in test/qbuilder.test.ts.
 */

export interface SearchFilters {
  query?: string;
  supertype?: "pokemon" | "trainer" | "energy";
  subtypes?: string[];
  types?: string[];
  textContains?: string;
  standardLegalOnly?: boolean;
  /** Regulation marks currently legal in standard, e.g. ["H","I","J"]. */
  legalMarks?: string[];
}

/** Heuristic: does the query look like a raw Lucene expression rather than a card name? */
export function looksLikeLucene(query: string): boolean {
  if (/(^|[\s(])-?[\w.]+:/.test(query)) return true;
  if (/\s(OR|AND|NOT)\s/.test(query)) return true;
  return false;
}

/** Quote a field value if it contains anything beyond a single safe token. */
export function quoteValue(value: string): string {
  const cleaned = value.trim().replace(/"/g, "");
  return /^[\w*.\-']+$/.test(cleaned) && !cleaned.includes(" ") ? cleaned : `"${cleaned}"`;
}

/**
 * Clause matching cards that are standard-legal by regulation mark, plus
 * basic energies (which carry no regulation mark but are always legal).
 */
export function standardClause(legalMarks: string[]): string {
  const markTerms = legalMarks.map((m) => `regulationMark:${m}`);
  return `(${markTerms.join(" OR ")} OR (supertype:energy subtypes:basic))`;
}

/** OR the phrase across every rules-text field a card can have. */
export function textContainsClause(text: string): string {
  const phrase = quoteValue(text);
  return `(attacks.text:${phrase} OR abilities.text:${phrase} OR rules:${phrase})`;
}

export function buildQuery(filters: SearchFilters): string {
  const clauses: string[] = [];
  const query = filters.query?.trim();
  if (query) {
    clauses.push(looksLikeLucene(query) ? `(${query})` : `name:${quoteValue(query)}`);
  }
  if (filters.supertype) clauses.push(`supertype:${filters.supertype}`);
  for (const subtype of filters.subtypes ?? []) clauses.push(`subtypes:${quoteValue(subtype)}`);
  for (const type of filters.types ?? []) clauses.push(`types:${quoteValue(type)}`);
  if (filters.textContains?.trim()) clauses.push(textContainsClause(filters.textContains));
  if (filters.standardLegalOnly && filters.legalMarks?.length) {
    clauses.push(standardClause(filters.legalMarks));
  }
  return clauses.join(" ").trim();
}

const STOPWORDS = new Set([
  "a", "an", "the", "of", "from", "to", "for", "on", "in", "at", "with", "and",
  "or", "that", "this", "each", "any", "all", "do", "does", "your", "you",
  "yours", "their", "them", "they", "one", "may", "can", "is", "are", "it",
  "its", "card", "cards", "pokemon", "pokémon", "when", "then", "than", "up",
]);

/**
 * Split free-form effect text into search keywords: lowercase, drop
 * stopwords, strip common suffixes so "benched"/"healing" become the stems
 * "bench"/"heal". Returns unique stems.
 */
export function extractKeywords(effectText: string): string[] {
  const tokens = effectText
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .map((t) => t.replace(/^'+|'+$/g, ""))
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
  const stems = tokens.map((t) => {
    if (/^\d+$/.test(t)) return t;
    let stem = t;
    for (const suffix of ["ing", "ed", "es", "s"]) {
      if (stem.length - suffix.length >= 4 && stem.endsWith(suffix)) {
        stem = stem.slice(0, -suffix.length);
        break;
      }
    }
    return stem;
  });
  return [...new Set(stems.filter((s) => s.length >= 3 || /^\d+$/.test(s)))];
}

/**
 * Forgiving effect search: OR every keyword (as a prefix wildcard) across
 * attack text, ability text and rules text. Ranking by match count happens
 * client-side.
 */
export function buildEffectQuery(keywords: string[]): string {
  const terms: string[] = [];
  for (const kw of keywords) {
    const term = /^\d+$/.test(kw) ? kw : `${kw}*`;
    terms.push(`attacks.text:${term}`, `abilities.text:${term}`, `rules:${term}`);
  }
  return `(${terms.join(" OR ")})`;
}
