/**
 * Shared card resolution for anything expressed as decklist lines: check_deck,
 * the collection tools and the deck builder. Set-code lines are resolved in
 * one query per set code (ORing card numbers, querying by set.id — see
 * SetResolver); everything else falls back to a name search that prefers
 * standard-legal printings.
 *
 * A failing lookup never aborts the batch: the affected entries stay
 * unresolved with an explanatory note. Only when EVERY entry failed and at
 * least one lookup errored does the whole resolution throw (a dead API
 * should read as a tool failure, not as "none of your cards exist").
 */
import { normalizeName, normNum, type DeckEntry } from "./deck.js";
import { isStandardLegal } from "./legality.js";
import { quoteValue } from "./qbuilder.js";
import type { SetResolver } from "./sets.js";
import type { TcgIoClient } from "./tcgio.js";
import type { Card } from "./types.js";

export interface Resolution {
  entry: DeckEntry;
  card?: Card;
  resolvedVia?: string;
  /** How the card was found — program logic keys off this, not off resolvedVia's wording. */
  via?: "set-code" | "name";
  notes: string[];
}

/** Numbers as the API stores them: no leading zeros, case untouched ("029"→"29", "GG44"→"GG44"). */
const stripLeadingZeros = (num: string): string => num.replace(/^0+(?=\d)/, "");

/** Bounded per-query number count: keeps URLs short and results under one page. */
const NUMBERS_PER_QUERY = 50;

export async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function resolveEntries(
  entries: DeckEntry[],
  api: TcgIoClient,
  resolver: SetResolver,
  marks: string[],
): Promise<Resolution[]> {
  const resolutions: Resolution[] = entries.map((entry) => ({ entry, notes: [] }));
  const errors: string[] = [];

  const mapping = await resolver.mapping();
  const byCode = new Map<string, Resolution[]>();
  const nameFallback: Resolution[] = [];
  for (const r of resolutions) {
    if (r.entry.setCode && r.entry.number) {
      if (mapping.has(r.entry.setCode)) {
        const group = byCode.get(r.entry.setCode) ?? [];
        group.push(r);
        byCode.set(r.entry.setCode, group);
      } else {
        r.notes.push(`unknown set code ${r.entry.setCode} — resolved by name instead`);
        nameFallback.push(r);
      }
    } else {
      nameFallback.push(r);
    }
  }

  // One query per set code (chunked for huge collections), ORing the card
  // numbers. Query by set.id from our mapping table — the set objects embedded
  // in card documents are missing ptcgoCode for several sets, so
  // `set.ptcgoCode:` misses cards that `set.id:` finds.
  await mapLimited([...byCode.entries()], 4, async ([code, group]) => {
    const sets = mapping.get(code)!;
    const setClause =
      sets.length === 1 ? `set.id:${sets[0].id}` : `(${sets.map((s) => `set.id:${s.id}`).join(" OR ")})`;
    const numbers = [...new Set(group.map((r) => stripLeadingZeros(r.entry.number!)))];
    const found = new Map<string, Card>();
    let failure: string | undefined;
    for (let i = 0; i < numbers.length; i += NUMBERS_PER_QUERY) {
      const chunk = numbers.slice(i, i + NUMBERS_PER_QUERY);
      const q = `${setClause} (${chunk.map((n) => `number:${n}`).join(" OR ")})`;
      try {
        const res = await api.searchCards(q);
        for (const c of res.cards) found.set(normNum(c.number), c);
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err);
        errors.push(failure);
      }
    }
    for (const r of group) {
      const card = found.get(normNum(r.entry.number!));
      if (card) {
        r.card = card;
        r.via = "set-code";
        r.resolvedVia = `${code} ${r.entry.number} → \`${card.id}\``;
      } else {
        r.notes.push(
          failure
            ? `${code} lookup failed (${failure}) — fell back to name lookup`
            : `${code} ${r.entry.number} not found — fell back to name lookup`,
        );
        nameFallback.push(r);
      }
    }
  });

  await mapLimited(nameFallback, 4, async (r) => {
    try {
      const res = await api.searchCards(`name:${quoteValue(r.entry.name)}`, {
        orderBy: "-set.releaseDate",
        pageSize: 60,
      });
      const exact = res.cards.filter((c) => normalizeName(c.name) === normalizeName(r.entry.name));
      const pool = exact.length > 0 ? exact : res.cards;
      const card = pool.find((c) => isStandardLegal(c, marks)) ?? pool[0];
      if (card) {
        r.card = card;
        r.via = "name";
        r.resolvedVia = `by name → \`${card.id}\``;
        if (exact.length === 0) r.notes.push(`no exact name match — using closest: "${card.name}"`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(message);
      r.notes.push(`name lookup failed: ${message}`);
    }
  });

  if (errors.length > 0 && resolutions.every((r) => !r.card)) {
    throw new Error(`card resolution failed: ${errors[0]}`);
  }
  return resolutions;
}
