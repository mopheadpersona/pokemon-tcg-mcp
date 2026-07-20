/**
 * Resolution for scanned card lines (see scan.ts for parsing). Four routes,
 * each batched:
 *
 * - EN set code + number → the shared decklist resolver (resolveEntries),
 *   one query per set code. The number is authoritative; a scanned name that
 *   disagrees with the resolved card gets a warning, not a rejection.
 * - Mapped JP set code (m5 → PBL) → resolved BY NAME within the mapped
 *   set(s), because JP collector numbers don't line up with EN numbering.
 *   Unmapped JP codes skip straight to the name search (JP printed totals
 *   don't match EN sets either).
 * - number/printedTotal ("031/084") with no set code → candidate sets are
 *   inferred from the printed total, then one query per total. A number match
 *   whose name disagrees with the scan falls back to the name search rather
 *   than guessing.
 * - Name only → newest standard-legal printing preferred, other printings
 *   kept as alternates. An unknown set-code-shaped token may really be the
 *   last word of the name ("Ultra Ball 196"), so those lines try the
 *   reassembled full name first, then the truncated one.
 *
 * Classification (which route a line takes) is pure and unit-tested; the
 * routes themselves are exercised end-to-end by scripts/smoke.mjs.
 */
import { normalizeName, normNum, type DeckEntry } from "./deck.js";
import { JP_SET_CODE_SHAPE, hasJapaneseText, jpSetCodeCandidates, translateJpName } from "./jpsets.js";
import { isStandardLegal } from "./legality.js";
import { quoteValue } from "./qbuilder.js";
import { mapLimited, resolveEntries } from "./resolve.js";
import type { ScannedLine } from "./scan.js";
import type { SetResolver } from "./sets.js";
import type { TcgIoClient } from "./tcgio.js";
import type { Card, SetInfo } from "./types.js";

export interface ScanResolution {
  line: ScannedLine;
  /** English card name after JP translation (equals line.name for EN input). */
  name: string;
  /** Set when an unknown set token may actually end the name ("Ultra Ball" for "Ultra Ball 196"). */
  fullName?: string;
  card?: Card;
  /** Other printings of the same card, for name-only lines. */
  alternates: Card[];
  notes: string[];
  /** Why the line stayed unresolved (bad set code / ambiguous name / not found / unresolved name). */
  reason?: string;
}

export type ScanRoute =
  | { kind: "set-code"; setCode: string }
  | { kind: "jp-set"; jpCode: string; liveCodes: string[] }
  | { kind: "slash-total"; printedTotal: number }
  | { kind: "name-only" };

/**
 * Decide which resolution route a parsed line takes. `enCodes` is the set of
 * known TCG Live/PTCGO codes from the live /sets mapping. `tokenMayBeName`
 * marks unknown non-JP set tokens that could be the last word of a multi-word
 * card name. Pure — unit tested.
 */
export function classifyScannedLine(
  line: Pick<ScannedLine, "setToken" | "number" | "printedTotal">,
  enCodes: ReadonlySet<string>,
): { route: ScanRoute; notes: string[]; tokenMayBeName?: boolean } {
  const notes: string[] = [];
  let tokenMayBeName = false;
  if (line.setToken && line.number) {
    const upper = line.setToken.toUpperCase();
    if (enCodes.has(upper)) return { route: { kind: "set-code", setCode: upper }, notes };
    const liveCodes = jpSetCodeCandidates(upper);
    if (liveCodes) return { route: { kind: "jp-set", jpCode: line.setToken, liveCodes }, notes };
    if (JP_SET_CODE_SHAPE.test(line.setToken)) {
      // JP collector numbers AND printed totals don't line up with EN sets,
      // so an unmapped JP code goes straight to the name search.
      notes.push(
        `JP set code "${line.setToken}" is not in the JP→EN mapping table (extend JP_SET_CODES in jpsets.ts) — falling back to a name search`,
      );
      return { route: { kind: "name-only" }, notes };
    }
    tokenMayBeName = true;
    notes.push(
      line.printedTotal !== undefined
        ? `"${line.setToken}" is not a known set code — inferring the set from the printed total /${line.printedTotal}`
        : `"${line.setToken}" is not a known set code — falling back to a name search (trying it as part of the name first)`,
    );
  }
  if (line.printedTotal !== undefined && line.number) {
    return { route: { kind: "slash-total", printedTotal: line.printedTotal }, notes, tokenMayBeName };
  }
  if (!line.setToken && line.number) {
    notes.push(`no set code before number ${line.number} — resolving by name, number kept as a hint`);
  }
  return { route: { kind: "name-only" }, notes, tokenMayBeName };
}

const stripLeadingZeros = (num: string): string => num.replace(/^0+(?=\d)/, "");

/** "29" → 29, "GG44" → 10044: plain numbers (regular prints) sort before lettered subset numbers. */
function numericRank(num: string): number {
  const digits = /\d+/.exec(num)?.[0];
  return (digits ? Number(digits) : 9999) + (/[A-Za-z]/.test(num) ? 10_000 : 0);
}

/** Newest-first (regular print before secret-rare reprints of the same set), standard-legal preferred, matching a number hint preferred most. */
function pickPreferred(cards: Card[], marks: string[], numberHint?: string): Card | undefined {
  const sorted = [...cards].sort(
    (a, b) =>
      (b.set.releaseDate ?? "").localeCompare(a.set.releaseDate ?? "") || numericRank(a.number) - numericRank(b.number),
  );
  const byNum = numberHint ? sorted.filter((c) => normNum(c.number) === normNum(numberHint)) : [];
  for (const pool of [byNum.filter((c) => isStandardLegal(c, marks)), byNum, sorted.filter((c) => isStandardLegal(c, marks)), sorted]) {
    if (pool.length > 0) return pool[0];
  }
  return undefined;
}

/** Distinct printings (set+number) of `card`'s name in `pool`, excluding `card` itself. */
function otherPrintings(card: Card, pool: Card[], cap = 6): Card[] {
  const seen = new Set([`${card.set.id}|${normNum(card.number)}`]);
  const out: Card[] = [];
  for (const c of pool) {
    if (normalizeName(c.name) !== normalizeName(card.name)) continue;
    const key = `${c.set.id}|${normNum(c.number)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
    if (out.length >= cap) break;
  }
  return out;
}

/** Names agree loosely: equal, or one contains the other ("Psychic Energy" vs "Basic Psychic Energy"). */
function namesCompatible(a: string, b: string): boolean {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  return na === nb || na.includes(nb) || nb.includes(na);
}

export async function resolveScanned(
  parsedLines: ScannedLine[],
  api: TcgIoClient,
  resolver: SetResolver,
  marks: string[],
): Promise<ScanResolution[]> {
  const mapping = await resolver.mapping();
  const enCodes = new Set(mapping.keys());
  const errors: string[] = [];

  const resolutions: ScanResolution[] = parsedLines.map((line) => ({
    line,
    name: line.name,
    alternates: [],
    notes: [],
  }));

  // ---- Classification + JP name translation. Lines resolved by EN
  // set+number don't need the name (the card supplies it); every other route
  // does.
  const routed = resolutions.map((r) => {
    const { route, notes, tokenMayBeName } = classifyScannedLine(r.line, enCodes);
    r.notes.push(...notes);
    if (hasJapaneseText(r.name)) {
      const translated = translateJpName(r.name);
      if (translated) {
        r.notes.push(`translated "${r.name}" → "${translated}"`);
        r.name = translated;
      } else if (route.kind !== "set-code") {
        r.reason =
          `unresolved name — "${r.name}" is not in the built-in JP→EN name map; ` +
          "give the English name (or retake the photo so the client can translate it)";
      } else {
        r.notes.push(`Japanese name "${r.name}" not translated — trusting the EN set code + number instead`);
      }
    }
    if (tokenMayBeName && r.line.setToken) r.fullName = `${r.name} ${r.line.setToken}`;
    return { r, route };
  });
  const active = routed.filter(({ r }) => !r.reason);

  // ---- Route 1: EN set code + number, via the shared resolver (batched per set code).
  const setCodeGroup = active.filter(({ route }) => route.kind === "set-code");
  if (setCodeGroup.length > 0) {
    const entries: DeckEntry[] = setCodeGroup.map(({ r, route }) => ({
      count: r.line.count,
      name: r.name,
      setCode: (route as Extract<ScanRoute, { kind: "set-code" }>).setCode,
      number: r.line.number!,
      line: r.line.index,
      raw: r.line.raw,
    }));
    try {
      const resolved = await resolveEntries(entries, api, resolver, marks);
      for (let i = 0; i < setCodeGroup.length; i++) {
        const { r } = setCodeGroup[i];
        const res = resolved[i];
        r.notes.push(...res.notes);
        if (res.card) {
          r.card = res.card;
          if (res.via === "set-code" && !hasJapaneseText(r.name) && !namesCompatible(r.name, res.card.name)) {
            r.notes.push(
              `⚠ scanned name "${r.name}" but ${res.entry.setCode} ${res.entry.number} is "${res.card.name}" — double-check the collector number`,
            );
          }
          r.name = res.card.name;
        } else {
          r.reason = res.notes.length > 0 ? res.notes.join("; ") : "not found on pokemontcg.io";
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(message);
      for (const { r } of setCodeGroup) r.reason = `lookup failed: ${message}`;
    }
  }

  // Fallback collector — routes below push lines here when their primary route misses.
  const nameFallback: ScanResolution[] = active.filter(({ route }) => route.kind === "name-only").map(({ r }) => r);

  // ---- Route 2: mapped JP set codes — resolve by name within the mapped
  // set(s). The scanned JP number is NOT used to pick a printing (JP and EN
  // numbering are unrelated); it is only echoed in a note.
  const jpGroups = new Map<string, { r: ScanResolution; route: Extract<ScanRoute, { kind: "jp-set" }> }[]>();
  for (const item of active) {
    if (item.route.kind !== "jp-set") continue;
    const key = item.route.jpCode.toUpperCase();
    const group = jpGroups.get(key) ?? [];
    group.push(item as { r: ScanResolution; route: Extract<ScanRoute, { kind: "jp-set" }> });
    jpGroups.set(key, group);
  }
  await mapLimited([...jpGroups.values()], 4, async (group) => {
    const { liveCodes, jpCode } = group[0].route;
    const sets: SetInfo[] = liveCodes.flatMap((code) => mapping.get(code.toUpperCase()) ?? []);
    if (sets.length === 0) {
      for (const { r } of group) {
        r.notes.push(`JP code ${jpCode} maps to ${liveCodes.join("/")}, but that set is not on pokemontcg.io yet — falling back to a name search`);
        nameFallback.push(r);
      }
      return;
    }
    const setClause = sets.length === 1 ? `set.id:${sets[0].id}` : `(${sets.map((s) => `set.id:${s.id}`).join(" OR ")})`;
    const names = [...new Set(group.map(({ r }) => quoteValue(r.name)))];
    try {
      const res = await api.searchCards(`${setClause} (${names.map((n) => `name:${n}`).join(" OR ")})`, { pageSize: 250 });
      for (const { r } of group) {
        const matches = res.cards.filter((c) => normalizeName(c.name) === normalizeName(r.name));
        const card = pickPreferred(matches, marks);
        if (card) {
          r.card = card;
          const numNote =
            r.line.number && normNum(r.line.number) !== normNum(card.number)
              ? `; JP collector number ${r.line.number} differs from the EN printing (${card.number}) — expected, JP sets number differently`
              : "";
          r.notes.push(`JP set ${jpCode} → ${card.set.name} (${liveCodes.join("/")}), matched by name${numNote}`);
        } else {
          r.notes.push(`"${r.name}" not found in ${sets.map((s) => s.name).join("/")} (JP ${jpCode}) — searched all sets by name instead`);
          nameFallback.push(r);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(message);
      for (const { r } of group) {
        r.notes.push(`JP-set lookup failed (${message}) — fell back to a name search`);
        nameFallback.push(r);
      }
    }
  });

  // ---- Route 3: number/printedTotal with no set code — infer candidate sets from the total.
  const slashGroups = new Map<number, ScanResolution[]>();
  for (const item of active) {
    if (item.route.kind !== "slash-total") continue;
    const group = slashGroups.get(item.route.printedTotal) ?? [];
    group.push(item.r);
    slashGroups.set(item.route.printedTotal, group);
  }
  if (slashGroups.size > 0) {
    let allSets: SetInfo[] = [];
    try {
      allSets = await api.getAllSets();
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
    await mapLimited([...slashGroups.entries()], 4, async ([total, group]) => {
      let candidates = allSets.filter((s) => s.printedTotal === total);
      if (candidates.length === 0) candidates = allSets.filter((s) => s.total === total);
      candidates.sort((a, b) => (b.releaseDate ?? "").localeCompare(a.releaseDate ?? ""));
      const capped = candidates.length > 8;
      candidates = candidates.slice(0, 8);
      if (candidates.length === 0) {
        for (const r of group) {
          r.notes.push(`no set on pokemontcg.io has a printed total of ${total} — resolving by name instead`);
          nameFallback.push(r);
        }
        return;
      }
      const setClause =
        candidates.length === 1
          ? `set.id:${candidates[0].id}`
          : `(${candidates.map((s) => `set.id:${s.id}`).join(" OR ")})`;
      const numbers = [...new Set(group.map((r) => stripLeadingZeros(r.line.number!)))];
      try {
        const res = await api.searchCards(`${setClause} (${numbers.map((n) => `number:${n}`).join(" OR ")})`, {
          pageSize: 250,
        });
        for (const r of group) {
          const numMatches = res.cards.filter((c) => normNum(c.number) === normNum(r.line.number!));
          const scannedName = r.fullName ?? r.name;
          const nameMatches = numMatches.filter(
            (c) => namesCompatible(c.name, r.name) || (r.fullName !== undefined && namesCompatible(c.name, r.fullName)),
          );
          if (nameMatches.length > 0) {
            const card = pickPreferred(nameMatches, marks)!;
            r.card = card;
            r.name = card.name;
            r.notes.push(
              `${r.line.number}/${String(total).padStart(3, "0")} matched ${card.set.name} (printed total ${total})${capped ? "; newest 8 candidate sets tried" : ""}`,
            );
          } else if (numMatches.length > 0) {
            // The number exists but under a different name — the total likely
            // pointed at the wrong set(s). Trust the scanned name instead.
            r.notes.push(
              `#${r.line.number} in ${[...new Set(numMatches.map((c) => c.set.name))].join("/")} is "${numMatches[0].name}", not "${scannedName}" — resolving by name instead`,
            );
            nameFallback.push(r);
          } else {
            r.notes.push(`no card #${r.line.number} in sets with printed total ${total} — resolving by name instead`);
            nameFallback.push(r);
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(message);
        for (const r of group) {
          r.notes.push(`printed-total lookup failed (${message}) — fell back to a name search`);
          nameFallback.push(r);
        }
      }
    });
  }

  // ---- Route 4: plain name search (also the shared fallback). One query per
  // distinct lookup name, newest standard-legal printing preferred, alternates
  // kept. Lines whose unknown set token may end the name ("Ultra Ball 196")
  // try the reassembled full name first, then the truncated one.
  async function runNamePass(items: { r: ScanResolution; lookup: string }[]): Promise<ScanResolution[]> {
    const groups = new Map<string, { r: ScanResolution; lookup: string }[]>();
    for (const item of items) {
      const key = normalizeName(item.lookup);
      const group = groups.get(key) ?? [];
      group.push(item);
      groups.set(key, group);
    }
    const misses: ScanResolution[] = [];
    await mapLimited([...groups.values()], 4, async (group) => {
      const lookup = group[0].lookup;
      try {
        let res = await api.searchCards(`name:${quoteValue(lookup)}`, { orderBy: "-set.releaseDate", pageSize: 60 });
        let fuzzyNote: string | undefined;
        if (res.cards.length === 0 && /^[\w'-]{4,}$/.test(lookup)) {
          res = await api.searchCards(`name:${lookup.replace(/["*]/g, "")}*`, { orderBy: "-set.releaseDate", pageSize: 60 });
          if (res.cards.length > 0) fuzzyNote = `no exact match for "${lookup}" — using prefix search`;
        }
        const exact = res.cards.filter((c) => normalizeName(c.name) === normalizeName(lookup));
        let pool = exact;
        if (exact.length === 0) {
          const distinct = new Map<string, Card>();
          for (const c of res.cards) if (!distinct.has(normalizeName(c.name))) distinct.set(normalizeName(c.name), c);
          if (distinct.size === 0) {
            for (const { r } of group) {
              r.reason = `not found — no card named "${lookup}" on pokemontcg.io; check the spelling or retake`;
              misses.push(r);
            }
            return;
          }
          if (distinct.size > 1) {
            const options = [...distinct.values()].slice(0, 4).map((c) => `"${c.name}"`).join(", ");
            for (const { r } of group) {
              r.reason = `ambiguous name — "${lookup}" is not an exact card name; did you mean: ${options}?`;
              misses.push(r);
            }
            return;
          }
          pool = res.cards;
        }
        for (const { r } of group) {
          if (fuzzyNote) r.notes.push(fuzzyNote);
          const card = pickPreferred(pool, marks, r.line.number);
          if (!card) {
            r.reason = `not found — no card named "${lookup}"`;
            misses.push(r);
            continue;
          }
          r.card = card;
          if (normalizeName(card.name) !== normalizeName(lookup)) r.notes.push(`closest name match: "${card.name}"`);
          r.name = card.name;
          r.alternates = otherPrintings(card, pool);
          if (!isStandardLegal(card, marks)) r.notes.push("no standard-legal printing of this name");
          else if (r.alternates.length > 0) r.notes.push(`picked the newest standard-legal printing; ${r.alternates.length} other printing(s) listed below`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(message);
        for (const { r } of group) {
          r.reason = `name lookup failed: ${message}`;
          misses.push(r);
        }
      }
    });
    return misses;
  }

  const pending = nameFallback.filter((r) => !r.reason && !r.card);
  const firstPass = pending.map((r) => ({ r, lookup: r.fullName ?? r.name }));
  const misses = await runNamePass(firstPass);
  // Second chance for "Ultra Ball 196"-style lines: the full name missed, so
  // the token really was a (bad) set code — retry with the truncated name.
  const retries = misses.filter((r) => r.fullName !== undefined && !r.reason?.startsWith("name lookup failed"));
  for (const r of retries) {
    r.notes.push(`"${r.fullName}" ${r.reason?.startsWith("ambiguous") ? "was ambiguous" : "not found"} — retrying as "${r.name}" with set token "${r.line.setToken}" dropped`);
    r.reason = undefined;
  }
  if (retries.length > 0) {
    await runNamePass(retries.map((r) => ({ r, lookup: r.name })));
  }

  // A dead API should read as a tool failure, not "none of your cards exist".
  if (errors.length > 0 && resolutions.every((r) => !r.card)) {
    throw new Error(`scanned-card resolution failed: ${errors[0]}`);
  }
  return resolutions;
}
