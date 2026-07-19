import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { countByName, looksLikeBasicEnergy, normalizeName, parseDecklist, type DeckEntry } from "./deck.js";
import {
  compactCardBlock,
  costString,
  eurPrice,
  fmtEur,
  fmtUsd,
  fullCardText,
  priceString,
  setRef,
  truncate,
  usdPrice,
} from "./format.js";
import { currentLegalMarks, isAceSpec, isBasicEnergy, isStandardLegal, standardBadge } from "./legality.js";
import { fetchMetaSnapshot } from "./limitless.js";
import { buildEffectQuery, buildQuery, extractKeywords, quoteValue, standardClause } from "./qbuilder.js";
import type { SetResolver } from "./sets.js";
import type { SearchResult, TcgIoClient } from "./tcgio.js";
import type { Card } from "./types.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: "text", text }], isError };
}

async function guard(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return textResult(`Tool failed: ${message}`, true);
  }
}

function normNum(num: string): string {
  return num.toUpperCase().replace(/^0+(?=\d)/, "");
}

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
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

function truncationNote(res: SearchResult): string | undefined {
  if (res.totalCount > res.cards.length) {
    return `_Note: ${res.totalCount} total matches on the server; only the first ${res.cards.length} were fetched — narrow the query for full coverage._`;
  }
  return undefined;
}

function marksNote(marks: string[]): string {
  return `_Standard legality computed from regulation marks (currently legal: ${marks.join(", ")}; basic energy always legal) — the API's own legality flags lag behind rotation._`;
}

const SUPERTYPE_INPUT = z.enum(["pokemon", "trainer", "energy"]);

export function registerTools(server: McpServer, api: TcgIoClient, resolver: SetResolver): void {
  // ---------------------------------------------------------------- search_cards
  server.registerTool(
    "search_cards",
    {
      title: "Search Pokémon TCG cards",
      description:
        "Search the pokemontcg.io card database. `query` accepts a card name or a raw Lucene query " +
        "(e.g. 'supertype:trainer subtypes:supporter'). Filters are ANDed. Returns compact card summaries.",
      inputSchema: {
        query: z.string().optional().describe("Card name or raw Lucene q (field:value syntax passes through)"),
        supertype: SUPERTYPE_INPUT.optional(),
        subtypes: z.array(z.string()).optional().describe('e.g. ["Supporter"] or ["Item", "ACE SPEC"]'),
        types: z.array(z.string()).optional().describe('Pokémon energy types, e.g. ["Psychic", "Water"]'),
        text_contains: z.string().optional().describe("Phrase to find in attack, ability or rules text"),
        standard_legal_only: z.boolean().default(true),
        max_results: z.number().int().min(1).max(50).default(15),
      },
    },
    async (args) =>
      guard(async () => {
        const marks = currentLegalMarks();
        const q = buildQuery({
          query: args.query,
          supertype: args.supertype,
          subtypes: args.subtypes,
          types: args.types,
          textContains: args.text_contains,
          standardLegalOnly: args.standard_legal_only,
          legalMarks: marks,
        });
        if (!q) return textResult("Provide a query or at least one filter.", true);
        const res = await api.searchCards(q, { orderBy: "-set.releaseDate" });
        let cards = res.cards;
        if (args.standard_legal_only) cards = cards.filter((c) => isStandardLegal(c, marks));
        if (cards.length === 0) {
          return textResult(
            `No cards matched \`${q}\`.` +
              (args.standard_legal_only ? " Try `standard_legal_only: false` to include rotated cards." : ""),
          );
        }
        const shown = cards.slice(0, args.max_results);
        const parts = [
          `### ${shown.length} of ${cards.length} matching cards — q: \`${q}\``,
          ...shown.map((c) => compactCardBlock(c, marks)),
        ];
        const note = truncationNote(res);
        if (note) parts.push(note);
        if (args.standard_legal_only) parts.push(marksNote(marks));
        return textResult(parts.join("\n"));
      }),
  );

  // ------------------------------------------------------------------- get_card
  server.registerTool(
    "get_card",
    {
      title: "Get full card details",
      description:
        "Fetch one card with full text, image URL and prices. Provide a pokemontcg.io `id` (e.g. 'me3-75'), " +
        "or an exact `name` plus optional TCG Live `set` code (e.g. name 'Jacinthe', set 'POR').",
      inputSchema: {
        id: z.string().optional().describe("pokemontcg.io card id, e.g. 'me3-75'"),
        name: z.string().optional().describe("Exact card name (used when no id is given)"),
        set: z.string().optional().describe("TCG Live set code to disambiguate, e.g. 'POR'"),
      },
    },
    async (args) =>
      guard(async () => {
        if (!args.id && !args.name) return textResult("Provide `id` or `name`.", true);
        const marks = currentLegalMarks();
        const notes: string[] = [];
        let card: Card | null = null;
        let otherPrintings: Card[] = [];

        if (args.id) {
          card = await api.getCardById(args.id);
          if (!card) return textResult(`No card with id \`${args.id}\`.`, true);
        } else {
          let q = `name:${quoteValue(args.name!)}`;
          if (args.set) {
            const sets = await resolver.lookup(args.set);
            if (sets.length > 0) q += ` (${sets.map((s) => `set.id:${s.id}`).join(" OR ")})`;
            else notes.push(`Set code "${args.set}" not recognized on pokemontcg.io — searched all sets instead.`);
          }
          const res = await api.searchCards(q, { orderBy: "-set.releaseDate", pageSize: 60 });
          const exact = res.cards.filter((c) => normalizeName(c.name) === normalizeName(args.name!));
          const pool = exact.length > 0 ? exact : res.cards;
          if (pool.length === 0) return textResult(`No card found for name "${args.name}". Try search_cards.`, true);
          if (exact.length === 0) notes.push(`No exact name match — showing closest: "${pool[0].name}".`);
          card = pool.find((c) => isStandardLegal(c, marks)) ?? pool[0];
          otherPrintings = pool.filter((c) => c.id !== card!.id).slice(0, 6);
        }

        const lines: string[] = [];
        const kind = [card.supertype, ...(card.subtypes ?? [])].join(" / ");
        lines.push(`## ${card.name} — ${kind}`);
        const facts: string[] = [`**Set:** ${setRef(card)}`];
        if (card.rarity) facts.push(`**Rarity:** ${card.rarity}`);
        if (card.regulationMark) facts.push(`**Reg mark:** ${card.regulationMark}`);
        facts.push(`**Standard:** ${standardBadge(card, marks)}`);
        if (card.legalities?.expanded) facts.push(`**Expanded:** ${card.legalities.expanded}`);
        lines.push(facts.join(" · "));

        if (card.supertype === "Pokémon") {
          const pokeFacts: string[] = [];
          if (card.hp) pokeFacts.push(`HP ${card.hp}`);
          if (card.types?.length) pokeFacts.push(card.types.join("/"));
          if (card.evolvesFrom) pokeFacts.push(`evolves from ${card.evolvesFrom}`);
          if (card.weaknesses?.length)
            pokeFacts.push(`weak ${card.weaknesses.map((w) => `${w.type} ${w.value}`).join(", ")}`);
          if (card.resistances?.length)
            pokeFacts.push(`resist ${card.resistances.map((r) => `${r.type} ${r.value}`).join(", ")}`);
          pokeFacts.push(`retreat ${costString(card.retreatCost)}`);
          lines.push(pokeFacts.join(" · "));
        }

        const text = fullCardText(card);
        if (text.length > 0) {
          lines.push("**Card text:**");
          for (const t of text) lines.push(`- ${t}`);
        }

        const priceBits: string[] = [];
        const eur = eurPrice(card);
        const usd = usdPrice(card);
        if (eur !== undefined)
          priceBits.push(`cardmarket trend ${fmtEur(eur)}${card.cardmarket?.url ? ` ([link](${card.cardmarket.url}))` : ""}`);
        if (usd !== undefined)
          priceBits.push(`tcgplayer market ${fmtUsd(usd)}${card.tcgplayer?.url ? ` ([link](${card.tcgplayer.url}))` : ""}`);
        lines.push(`**Prices:** ${priceBits.length ? priceBits.join(" · ") : "no price data"}`);

        if (card.images?.large ?? card.images?.small) lines.push(`**Image:** ${card.images.large ?? card.images.small}`);
        lines.push(`\`id: ${card.id}\``);
        if (otherPrintings.length > 0) {
          lines.push(`Other printings: ${otherPrintings.map((c) => `\`${c.id}\` (${setRef(c)})`).join(", ")}`);
        }
        lines.push(...notes.map((n) => `_${n}_`));
        return textResult(lines.join("\n"));
      }),
  );

  // ------------------------------------------------------- find_similar_effects
  server.registerTool(
    "find_similar_effects",
    {
      title: "Find cards by effect",
      description:
        "Discovery tool: describe an effect in plain words (e.g. 'heal damage from benched pokemon') and get " +
        "cards whose attack/ability/rules text matches. Keywords are ORed and results ranked by match count.",
      inputSchema: {
        effect_text: z.string().describe("Plain-language description of the effect"),
        supertype: SUPERTYPE_INPUT.optional(),
        standard_legal_only: z.boolean().default(true),
        max_results: z.number().int().min(1).max(50).default(15),
      },
    },
    async (args) =>
      guard(async () => {
        const keywords = extractKeywords(args.effect_text);
        if (keywords.length === 0) {
          return textResult("Could not extract any usable keywords from `effect_text`.", true);
        }
        const marks = currentLegalMarks();
        let q = buildEffectQuery(keywords);
        if (args.supertype) q += ` supertype:${args.supertype}`;
        if (args.standard_legal_only) q += ` ${standardClause(marks)}`;
        // Newest sets first; fetch a second page when the OR query is broad so
        // recent cards aren't cut off. Bounded at 2 requests — never loops.
        const res = await api.searchCards(q, { orderBy: "-set.releaseDate" });
        let cards = res.cards;
        if (res.totalCount > res.pageSize) {
          const page2 = await api.searchCards(q, { orderBy: "-set.releaseDate", page: 2 });
          cards = [...cards, ...page2.cards];
        }
        if (args.standard_legal_only) cards = cards.filter((c) => isStandardLegal(c, marks));

        // Rank by keyword coverage; the first keyword is usually the core verb
        // ("heal …"), so it breaks ties ahead of incidental matches.
        const scored = cards
          .map((card) => {
            const combined = [
              ...(card.attacks ?? []).map((a) => a.text ?? ""),
              ...(card.abilities ?? []).map((a) => a.text),
              ...(card.rules ?? []),
            ]
              .join(" ")
              .toLowerCase();
            const matched = keywords.filter((k) => combined.includes(k));
            const score = matched.length + (matched.includes(keywords[0]) ? 0.5 : 0);
            return { card, matched, score };
          })
          .filter((s) => s.matched.length > 0)
          .sort(
            (a, b) =>
              b.score - a.score || (b.card.set.releaseDate ?? "").localeCompare(a.card.set.releaseDate ?? ""),
          );

        if (scored.length === 0) {
          return textResult(
            `No cards matched keywords [${keywords.join(", ")}].` +
              (args.standard_legal_only ? " Try `standard_legal_only: false`." : ""),
          );
        }
        const shown = scored.slice(0, args.max_results);
        const parts = [
          `### Effect search — keywords: ${keywords.join(", ")} (${shown.length} of ${scored.length} matches shown)`,
          ...shown.map(
            (s) =>
              `${compactCardBlock(s.card, marks)}\n  _matched ${s.matched.length}/${keywords.length}: ${s.matched.join(", ")}_`,
          ),
        ];
        if (res.totalCount > cards.length) {
          parts.push(
            `_Note: ${res.totalCount} raw matches on the server; ranked the newest ${cards.length} — add more specific keywords for full coverage._`,
          );
        }
        return textResult(parts.join("\n"));
      }),
  );

  // ----------------------------------------------------------------- check_deck
  server.registerTool(
    "check_deck",
    {
      title: "Validate a decklist",
      description:
        "Validate a TCG Live export decklist (lines like '4 Slowpoke PBL 29'): 60-card total, max 4 copies " +
        "per name (basic energy exempt), max 1 ACE SPEC, standard legality per card, plus a cardmarket price estimate.",
      inputSchema: {
        decklist: z.string().describe("Decklist text in TCG Live export format"),
      },
    },
    async (args) =>
      guard(async () => {
        const parsed = parseDecklist(args.decklist);
        if (parsed.entries.length === 0) {
          return textResult("No card lines recognized. Expected TCG Live export lines like `4 Slowpoke PBL 29`.", true);
        }
        const marks = currentLegalMarks();

        interface Resolution {
          entry: DeckEntry;
          card?: Card;
          resolvedVia?: string;
          notes: string[];
        }
        const resolutions: Resolution[] = parsed.entries.map((entry) => ({ entry, notes: [] }));

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

        // One query per set code, ORing all needed card numbers. Query by
        // set.id from our mapping table — the set objects embedded in card
        // documents are missing ptcgoCode for several sets, so
        // `set.ptcgoCode:` misses cards that `set.id:` finds.
        await mapLimited([...byCode.entries()], 4, async ([code, group]) => {
          const sets = mapping.get(code)!;
          const setClause =
            sets.length === 1 ? `set.id:${sets[0].id}` : `(${sets.map((s) => `set.id:${s.id}`).join(" OR ")})`;
          const numbers = [...new Set(group.map((r) => r.entry.number!))];
          const q = `${setClause} (${numbers.map((n) => `number:${n}`).join(" OR ")})`;
          const res = await api.searchCards(q);
          const found = new Map(res.cards.map((c) => [normNum(c.number), c]));
          for (const r of group) {
            const card = found.get(normNum(r.entry.number!));
            if (card) {
              r.card = card;
              r.resolvedVia = `${code} ${r.entry.number} → \`${card.id}\``;
            } else {
              r.notes.push(`${code} ${r.entry.number} not found — fell back to name lookup`);
              nameFallback.push(r);
            }
          }
        });

        await mapLimited(nameFallback, 4, async (r) => {
          const res = await api.searchCards(`name:${quoteValue(r.entry.name)}`, {
            orderBy: "-set.releaseDate",
            pageSize: 60,
          });
          const exact = res.cards.filter((c) => normalizeName(c.name) === normalizeName(r.entry.name));
          const pool = exact.length > 0 ? exact : res.cards;
          const card = pool.find((c) => isStandardLegal(c, marks)) ?? pool[0];
          if (card) {
            r.card = card;
            r.resolvedVia = `by name → \`${card.id}\``;
            if (exact.length === 0) r.notes.push(`no exact name match — using closest: "${card.name}"`);
          }
        });

        const problems: string[] = [];
        if (parsed.totalCards !== 60) {
          problems.push(`Deck has **${parsed.totalCards}** cards — a standard deck must have exactly 60.`);
        }

        const isEnergyRes = (r: Resolution) =>
          r.card ? isBasicEnergy(r.card) : looksLikeBasicEnergy(r.entry.name);
        const countedEntries = resolutions.filter((r) => !isEnergyRes(r)).map((r) => r.entry);
        for (const [name, count] of countByName(countedEntries)) {
          if (count > 4) {
            problems.push(`**${count}× “${name}”** — max 4 copies of a card with the same name (basic energy exempt).`);
          }
        }

        const aceSpecs = resolutions.filter((r) => r.card && isAceSpec(r.card));
        const aceSpecCount = aceSpecs.reduce((sum, r) => sum + r.entry.count, 0);
        if (aceSpecCount > 1) {
          problems.push(
            `**${aceSpecCount} ACE SPEC cards** (${aceSpecs.map((r) => r.entry.name).join(", ")}) — only 1 ACE SPEC allowed per deck.`,
          );
        }

        for (const r of resolutions) {
          if (r.card && !isStandardLegal(r.card, marks)) {
            const reason = r.card.regulationMark
              ? `regulation mark ${r.card.regulationMark} is rotated (legal: ${marks.join(", ")})`
              : "no regulation mark";
            problems.push(`**“${r.entry.name}”** (${setRef(r.card)}) is not standard-legal — ${reason}.`);
          }
          if (!r.card) {
            problems.push(
              `Could not resolve **“${r.entry.name}”** (line ${r.entry.line}) — legality and price unchecked.`,
            );
          }
        }

        let totalEur = 0;
        let pricedCards = 0;
        for (const r of resolutions) {
          const eur = r.card ? eurPrice(r.card) : undefined;
          if (eur !== undefined) {
            totalEur += eur * r.entry.count;
            pricedCards += r.entry.count;
          }
        }

        const lines: string[] = [`## Deck check — ${parsed.totalCards} cards, ${parsed.entries.length} distinct lines`];
        if (problems.length > 0) {
          lines.push(`### ❌ ${problems.length} problem${problems.length > 1 ? "s" : ""}`);
          lines.push(...problems.map((p) => `- ${p}`));
        } else {
          lines.push("### ✅ No problems — deck is standard-legal");
        }
        if (parsed.warnings.length > 0) {
          lines.push("### Parser notes");
          lines.push(...parsed.warnings.map((w) => `- ${w}`));
        }
        lines.push("### Cards");
        lines.push("| Qty | Card | Resolved | Reg | Std | € each | Notes |");
        lines.push("|---|---|---|---|---|---|---|");
        for (const r of resolutions) {
          const card = r.card;
          lines.push(
            `| ${r.entry.count} | ${r.entry.name} | ${r.resolvedVia ?? "✗ unresolved"} | ${card?.regulationMark ?? "–"} | ` +
              `${card ? (isStandardLegal(card, marks) ? "✓" : "✗") : "?"} | ${card ? fmtEur(eurPrice(card)) : "–"} | ${r.notes.join("; ")} |`,
          );
        }
        lines.push(
          `### Price\nEstimated total: **${fmtEur(totalEur)}** (cardmarket trend; ${pricedCards} of ${parsed.totalCards} cards priced)`,
        );
        lines.push(marksNote(marks));
        return textResult(lines.join("\n"));
      }),
  );

  // -------------------------------------------------------------- meta_snapshot
  server.registerTool(
    "meta_snapshot",
    {
      title: "Competitive meta snapshot",
      description:
        "Current top archetypes from Limitless TCG (limitlesstcg.com/decks) with tournament points and meta " +
        "share. Returns a clear 'source unavailable' message if the live data can't be fetched — never stale guesses.",
      inputSchema: {
        format: z.enum(["standard", "expanded"]).default("standard"),
        max_results: z.number().int().min(1).max(30).default(12),
      },
    },
    async (args) =>
      guard(async () => {
        let snapshot;
        try {
          snapshot = await fetchMetaSnapshot(args.format);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return textResult(
            `Limitless meta source unavailable (${message}). No cached or guessed data to show — ` +
              `check https://limitlesstcg.com/decks directly.`,
          );
        }
        const rows = snapshot.rows.slice(0, args.max_results);
        const lines = [
          `## ${args.format[0].toUpperCase()}${args.format.slice(1)} meta snapshot — Limitless TCG`,
          `Source: ${snapshot.sourceUrl} (tournament points from recent major events; fetched live, cached ≤1h)`,
          "| # | Archetype | Points | Share |",
          "|---|---|---|---|",
          ...rows.map((r) => `| ${r.rank} | [${r.name}](${r.url}) | ${r.points} | ${r.share} |`),
        ];
        return textResult(lines.join("\n"));
      }),
  );

  // ---------------------------------------------------------------- price_check
  server.registerTool(
    "price_check",
    {
      title: "Price check across printings",
      description:
        "Cardmarket (EUR) and TCGplayer (USD) prices for every printing of a card, with the cheapest " +
        "standard-playable version highlighted.",
      inputSchema: {
        name: z.string().describe("Card name, e.g. 'Jacinthe'"),
        set: z.string().optional().describe("Optional TCG Live set code to narrow, e.g. 'POR'"),
      },
    },
    async (args) =>
      guard(async () => {
        const marks = currentLegalMarks();
        const notes: string[] = [];
        let q = `name:${quoteValue(args.name)}`;
        if (args.set) {
          const sets = await resolver.lookup(args.set);
          if (sets.length > 0) q += ` (${sets.map((s) => `set.id:${s.id}`).join(" OR ")})`;
          else notes.push(`Set code "${args.set}" not recognized — showing all printings.`);
        }
        const res = await api.searchCards(q, { orderBy: "-set.releaseDate", pageSize: 100 });
        const exact = res.cards.filter((c) => normalizeName(c.name) === normalizeName(args.name));
        const printings = exact.length > 0 ? exact : res.cards;
        if (printings.length === 0) {
          return textResult(`No printings found for "${args.name}". Try search_cards for fuzzy discovery.`, true);
        }
        if (exact.length === 0) notes.push(`No exact name match — showing closest matches.`);

        const withEur = printings.filter((c) => isStandardLegal(c, marks) && eurPrice(c) !== undefined);
        const withUsd = printings.filter((c) => isStandardLegal(c, marks) && usdPrice(c) !== undefined);
        const cheapest =
          withEur.sort((a, b) => eurPrice(a)! - eurPrice(b)!)[0] ?? withUsd.sort((a, b) => usdPrice(a)! - usdPrice(b)!)[0];

        const lines = [`## Prices — ${printings[0].name} (${printings.length} printings)`];
        lines.push("| Set | # | Rarity | Reg | Std | Cardmarket (trend) | TCGplayer (market) |");
        lines.push("|---|---|---|---|---|---|---|");
        for (const c of printings) {
          const cheap = cheapest && c.id === cheapest.id ? " ⭐" : "";
          lines.push(
            `| ${c.set.name}${c.set.ptcgoCode ? ` (${c.set.ptcgoCode})` : ""}${cheap} | ${c.number} | ${c.rarity ?? "–"} | ` +
              `${c.regulationMark ?? "–"} | ${isStandardLegal(c, marks) ? "✓" : "✗"} | ${fmtEur(eurPrice(c))} | ${fmtUsd(usdPrice(c))} |`,
          );
        }
        if (cheapest) {
          lines.push(
            `\n⭐ **Cheapest standard-playable copy:** ${setRef(cheapest)} — ${priceString(cheapest)}` +
              `${cheapest.cardmarket?.url ? ` · [cardmarket](${cheapest.cardmarket.url})` : ""}` +
              `${cheapest.tcgplayer?.url ? ` · [tcgplayer](${cheapest.tcgplayer.url})` : ""}`,
          );
        } else {
          lines.push("\n_No standard-legal printing with price data — deck builders beware._");
        }
        if (res.totalCount > res.cards.length) {
          lines.push(
            `_Showing the newest ${printings.length} printings — ${res.totalCount} matches total on the server._`,
          );
        }
        lines.push(...notes.map((n) => `_${n}_`));
        lines.push(marksNote(marks));
        return textResult(lines.join("\n"));
      }),
  );
}
