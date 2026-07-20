/**
 * build_decks: the collection-aware deck builder tool. All deck construction
 * is deterministic code in deckbuilder.ts/counterscore.ts; this file resolves
 * the collection, renders results, and (with owned_only=false) suggests a few
 * cards to acquire for the biggest gaps.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { collectionFilePath, loadCollectionText, parseCollection } from "./collection.js";
import { buildDecksFromCollection, guidelines, type BuiltDeck, type OwnedCard } from "./deckbuilder.js";
import { isDrawSupporter, isSwitchCard } from "./effects.js";
import { eurPrice, liveLine, marksNote, priceString, setRef, usdPrice } from "./format.js";
import { currentLegalMarks, isStandardLegal } from "./legality.js";
import { standardClause, textContainsClause } from "./qbuilder.js";
import { resolveEntries, type Resolution } from "./resolve.js";
import type { SetResolver } from "./sets.js";
import type { TcgIoClient } from "./tcgio.js";
import { guard, textResult } from "./toolutil.js";
import type { Card } from "./types.js";
import { deckProblems } from "./validate.js";

function renderDeck(
  deck: BuiltDeck,
  index: number,
  deckSize: 40 | 60,
  marks: string[],
  format: string,
  codeOf: (setId: string) => string | undefined,
): string[] {
  const lines: string[] = [`### Deck ${index} — ${deck.coreLines[0].topAttacker.name} (${deck.total} cards)`];

  const groups: [string, typeof deck.cards][] = (["Pokémon", "Trainer", "Energy"] as const).map((supertype) => [
    supertype,
    deck.cards.filter((c) => c.card.supertype === supertype),
  ]);
  const list: string[] = [];
  for (const [supertype, cards] of groups) {
    if (cards.length === 0) continue;
    list.push(`${supertype}: ${cards.reduce((s, c) => s + c.count, 0)}`);
    list.push(...cards.map((c) => liveLine(c.card, c.count, codeOf)));
    list.push("");
  }
  list.push(`Total Cards: ${deck.total}`);
  lines.push("```", ...list, "```");

  lines.push(`**Why:** ${deck.strategy}`);
  lines.push(
    `**Starters:** ${deck.counts.basics} basics · **Draw:** ${deck.counts.draw} supporters · ` +
      `**Search:** ${deck.counts.search} · **Switch:** ${deck.counts.switch} · **Energy:** ${deck.counts.energy}`,
  );
  lines.push("**Known weaknesses:**");
  lines.push(...(deck.weaknesses.length > 0 ? deck.weaknesses.map((w) => `- ${w}`) : ["- none flagged"]));
  if (deck.warnings.length > 0) {
    lines.push("**Build warnings:**", ...deck.warnings.map((w) => `- ${w}`));
  }

  // Validate through the shared check_deck rules before returning.
  const resolutions: Resolution[] = deck.cards.map((c) => ({
    entry: { count: c.count, name: c.card.name, line: 0, raw: liveLine(c.card, c.count, codeOf) },
    card: c.card,
    notes: [],
  }));
  const problems = deckProblems(resolutions, deck.total, {
    deckSize,
    marks,
    ignoreRegulation: format === "unrestricted",
  });
  lines.push(
    problems.length === 0
      ? "**Validation (check_deck rules):** ✅ size, copy limits, ACE SPEC and legality all pass"
      : ["**Validation (check_deck rules):** ❌", ...problems.map((p) => `- ${p}`)].join("\n"),
  );
  return lines;
}

/** With owned_only=false: up to maxProxies copies of gap-filling cards to acquire (never added to the list). */
async function suggestAcquisitions(
  deck: BuiltDeck,
  deckSize: 40 | 60,
  marks: string[],
  maxProxies: number,
  api: TcgIoClient,
): Promise<string[]> {
  const g = guidelines(deckSize);
  const mainType = deck.energyTypes[0];
  interface Gap {
    need: number;
    label: string;
    q: string;
    filter?: (c: Card) => boolean;
  }
  const gaps: Gap[] = [];
  if (deck.counts.draw < g.draw[0]) {
    gaps.push({
      need: g.draw[0] - deck.counts.draw,
      label: "draw-supporter gap",
      q: `supertype:trainer subtypes:supporter rules:draw* ${standardClause(marks)}`,
      filter: isDrawSupporter,
    });
  }
  if (deck.counts.switch < g.switch[0]) {
    gaps.push({
      need: g.switch[0] - deck.counts.switch,
      label: "switch-effect gap",
      q: `supertype:trainer subtypes:item ${textContainsClause("Switch your Active")} ${standardClause(marks)}`,
      filter: isSwitchCard,
    });
  }
  if (deck.counts.energy < g.energy[0] && mainType) {
    gaps.push({
      need: g.energy[0] - deck.counts.energy,
      label: "energy gap",
      q: `supertype:energy subtypes:basic name:${mainType}`,
    });
  }
  if (deck.counts.basics < g.minBasics && mainType) {
    gaps.push({
      need: g.minBasics - deck.counts.basics,
      label: "starter gap (mulligan risk)",
      q: `supertype:pokemon subtypes:basic types:${mainType} ${standardClause(marks)}`,
    });
  }

  let budget = maxProxies;
  const out: string[] = [];
  for (const gap of gaps.slice(0, 3)) {
    if (budget <= 0) break;
    const res = await api.searchCards(gap.q, { orderBy: "-set.releaseDate", pageSize: 50 });
    const candidates = res.cards.filter((c) => isStandardLegal(c, marks)).filter(gap.filter ?? (() => true));
    const pick = candidates.find((c) => eurPrice(c) !== undefined || usdPrice(c) !== undefined) ?? candidates[0];
    if (!pick) continue;
    const n = Math.min(gap.need, budget, 4);
    budget -= n;
    out.push(`- ${n} × **${pick.name}** (${setRef(pick)}) — ${gap.label} · ${priceString(pick)}`);
  }
  return out;
}

export function registerBuildTools(server: McpServer, api: TcgIoClient, resolver: SetResolver): void {
  server.registerTool(
    "build_decks",
    {
      title: "Build decks from the collection",
      description:
        "Deterministic deck builder over the local collection file: groups Pokémon into evolution-line " +
        "attacker cores (evolvesFrom), assembles starters (8+ basics for 60 cards), draw supporters, search, " +
        "switch and matched energy to the exact deck size, and validates with the check_deck rules. With " +
        "deck_count=2 the pair is rebuilt up to 5 times to minimize a counter-score (weakness exploitation, " +
        "status vs no-cure, energy denial, snipe vs bench, tempo) and the breakdown is reported.",
      inputSchema: {
        deck_count: z.number().int().min(1).max(2).default(1),
        deck_size: z
          .union([z.literal(40), z.literal(60)])
          .default(60)
          .describe("40-card decks (4 prizes) use guideline proportions scaled by 2/3"),
        format: z
          .enum(["standard", "unrestricted"])
          .default("standard")
          .describe("unrestricted = home play: regulation marks ignored, copy limits still enforced"),
        must_include: z.array(z.string()).optional().describe("Card names to build around, e.g. ['Aromatisse']"),
        owned_only: z.boolean().default(true).describe("false: also suggest up to max_proxies cards to acquire"),
        max_proxies: z.number().int().min(0).max(20).default(5),
      },
    },
    async (args) =>
      guard(async () => {
        const path = collectionFilePath();
        const text = await loadCollectionText(path);
        if (text.trim() === "") {
          return textResult(`Collection file \`${path}\` is empty or missing — add cards with collection_add first.`, true);
        }
        const { entries, warnings: parseWarnings } = parseCollection(text);
        if (entries.length === 0) return textResult(`No card lines in \`${path}\` — nothing to build from.`, true);

        const marks = currentLegalMarks();
        const resolutions = await resolveEntries(entries, api, resolver, marks);
        const owned: OwnedCard[] = resolutions
          .filter((r) => r.card)
          .map((r) => ({ card: r.card!, count: r.entry.count }));
        const unresolved = resolutions
          .filter((r) => !r.card)
          .map((r) => `Line ${r.entry.line} "${r.entry.raw}" could not be resolved — ignored for building.`);

        const result = buildDecksFromCollection(owned, {
          deckCount: args.deck_count as 1 | 2,
          deckSize: args.deck_size as 40 | 60,
          format: args.format,
          legalMarks: marks,
          mustInclude: args.must_include,
        });

        const lines = [
          `## build_decks — ${args.deck_count} × ${args.deck_size}-card ${args.format} deck${args.deck_count > 1 ? "s" : ""} from \`${path}\``,
        ];
        if (result.decks.length === 0) {
          lines.push("Could not build a deck from this collection:");
          lines.push(...[...result.warnings, ...unresolved].map((w) => `- ${w}`));
          return textResult(lines.join("\n"), true);
        }

        const reverse = await resolver.reverseMapping();
        const codeOf = (setId: string): string | undefined => reverse.get(setId);
        for (const [i, deck] of result.decks.entries()) {
          lines.push(...renderDeck(deck, i + 1, args.deck_size as 40 | 60, marks, args.format, codeOf));
          if (!args.owned_only) {
            const suggestions = await suggestAcquisitions(deck, args.deck_size as 40 | 60, marks, args.max_proxies, api);
            if (suggestions.length > 0) {
              lines.push(`**Worth acquiring (≤${args.max_proxies} copies, not in the list above):**`, ...suggestions);
            }
          }
        }

        if (result.counter) {
          const c = result.counter;
          lines.push(`### Matchup balance — counter-score **${c.total}/10**`);
          if (result.attempts !== undefined) {
            lines.push(`_Best pair after ${result.attempts} build attempt${result.attempts > 1 ? "s" : ""} (max 5)._`);
          }
          lines.push("| # | Component | Weight | Score | Note |", "|---|---|---|---|---|");
          for (const comp of c.components) {
            lines.push(
              `| ${comp.id} | ${comp.name} | ${comp.weight} | ${comp.score} | ${comp.triggered ? comp.explanation : "—"} |`,
            );
          }
          lines.push(`**Verdict:** ${c.verdict}`);
        }

        const allWarnings = [...parseWarnings, ...unresolved, ...result.warnings];
        if (allWarnings.length > 0) {
          lines.push("### Warnings", ...allWarnings.map((w) => `- ${w}`));
        }
        if (args.format === "standard") lines.push(marksNote(marks));
        return textResult(lines.join("\n"));
      }),
  );
}
