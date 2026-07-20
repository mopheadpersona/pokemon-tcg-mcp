/**
 * Collection tools: a local card collection in a plain text file
 * (POKEMON_COLLECTION_PATH, default ./collection.txt), same line format as
 * TCG Live decklists, `#` comments allowed.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  addToCollectionText,
  collectionFilePath,
  loadCollectionText,
  parseCollection,
  removeFromCollectionText,
  saveCollectionText,
  type LineSpec,
} from "./collection.js";
import { countByName, looksLikeBasicEnergy, normalizeName, parseDecklist } from "./deck.js";
import { marksNote, setRef } from "./format.js";
import { currentLegalMarks, isStandardLegal, standardBadge } from "./legality.js";
import { quoteValue } from "./qbuilder.js";
import { resolveEntries, type Resolution } from "./resolve.js";
import type { SetResolver } from "./sets.js";
import type { TcgIoClient } from "./tcgio.js";
import { guard, textResult } from "./toolutil.js";
import type { Card } from "./types.js";

/** Summary header numbers for collection_list. Pure — unit tested. */
export function collectionSummary(
  resolutions: Resolution[],
  marks: string[],
): { totalCards: number; uniqueNames: number; legalCopies: number } {
  const entries = resolutions.map((r) => r.entry);
  return {
    totalCards: entries.reduce((sum, e) => sum + e.count, 0),
    uniqueNames: countByName(entries).size,
    legalCopies: resolutions.reduce(
      (sum, r) => sum + (r.card && isStandardLegal(r.card, marks) ? r.entry.count : 0),
      0,
    ),
  };
}

export interface NameAddClassification {
  outcome: "accepted" | "ambiguous" | "not-found";
  /** The line to write, when accepted. */
  spec?: { count: number; name: string; setCode?: string; number?: string };
  /** Distinct printings, when ambiguous. */
  candidates?: Card[];
}

/**
 * Decide what a bare-name collection_add line means, given the API's search
 * results for that name: unique printing → accept (recovering the set code
 * from the /sets mapping when the embedded ptcgoCode is missing); several
 * printings → ambiguous, change nothing. Pure — unit tested.
 */
export function classifyNameOnlyAdd(
  entry: { count: number; name: string },
  searchResults: Card[],
  setCodeOf: (setId: string) => string | undefined,
): NameAddClassification {
  const exact = searchResults.filter((c) => normalizeName(c.name) === normalizeName(entry.name));
  if (exact.length === 0) return { outcome: "not-found" };
  const printings = new Map<string, Card>();
  for (const c of exact) printings.set(`${c.set.id}|${c.number}`, c);
  if (printings.size > 1) return { outcome: "ambiguous", candidates: [...printings.values()] };
  const card = [...printings.values()][0];
  const code = card.set.ptcgoCode ?? setCodeOf(card.set.id);
  return {
    outcome: "accepted",
    spec: {
      count: entry.count,
      name: card.name,
      setCode: code,
      number: code ? card.number : undefined,
    },
  };
}

export function registerCollectionTools(server: McpServer, api: TcgIoClient, resolver: SetResolver): void {
  // ------------------------------------------------------------ collection_list
  server.registerTool(
    "collection_list",
    {
      title: "List the local collection",
      description:
        "Parsed & resolved view of the local collection file (env POKEMON_COLLECTION_PATH, default " +
        "./collection.txt; TCG Live line format, `#` comments allowed): per-line counts, sets, kinds and " +
        "standard legality plus summary totals. Unresolvable lines become warnings, never errors.",
      inputSchema: {},
    },
    async () =>
      guard(async () => {
        const path = collectionFilePath();
        const text = await loadCollectionText(path);
        if (text.trim() === "") {
          return textResult(`Collection file \`${path}\` is empty or missing — add cards with collection_add.`);
        }
        const { entries, warnings } = parseCollection(text);
        if (entries.length === 0) {
          const extra = warnings.length > 0 ? `\n${warnings.map((w) => `- ${w}`).join("\n")}` : "";
          return textResult(`No card lines in \`${path}\`.${extra}`);
        }
        const marks = currentLegalMarks();
        const resolutions = await resolveEntries(entries, api, resolver, marks);
        const { totalCards, uniqueNames, legalCopies } = collectionSummary(resolutions, marks);

        const lines = [
          `## Collection — \`${path}\``,
          `**${totalCards} cards** · **${uniqueNames} unique names** · **${legalCopies} standard-legal copies**`,
          "| Qty | Card | Set | Kind | Reg | Std |",
          "|---|---|---|---|---|---|",
        ];
        for (const r of resolutions) {
          const c = r.card;
          const kind = c ? [c.supertype, (c.subtypes ?? [])[0]].filter(Boolean).join("/") : "?";
          lines.push(
            `| ${r.entry.count} | ${r.entry.name} | ${c ? setRef(c) : "✗ unresolved"} | ${kind} | ` +
              `${c?.regulationMark ?? "–"} | ${c ? (isStandardLegal(c, marks) ? "✓" : "✗") : "?"} |`,
          );
        }

        const allWarnings = [
          ...warnings,
          ...resolutions
            .filter((r) => !r.card)
            .map((r) => `Line ${r.entry.line} "${r.entry.raw}" could not be resolved — kept in the file, skipped by the deck builder.`),
          ...resolutions.flatMap((r) => r.notes.map((n) => `${r.entry.name}: ${n}`)),
        ];
        if (allWarnings.length > 0) {
          lines.push("### Warnings");
          lines.push(...allWarnings.map((w) => `- ${w}`));
        }
        lines.push(marksNote(marks));
        return textResult(lines.join("\n"));
      }),
  );

  // ------------------------------------------------------------- collection_add
  server.registerTool(
    "collection_add",
    {
      title: "Add cards to the collection",
      description:
        "Append or increment cards in the collection file. Input: lines in TCG Live format " +
        "('4 Jacinthe POR 75'), one per line. A name without a set code is looked up; if several printings " +
        "match, nothing changes and the candidates are listed. Comments in the file are preserved.",
      inputSchema: {
        lines: z.string().describe("Card lines to add, e.g. '4 Jacinthe POR 75\\n2 Slowpoke PBL 29'"),
      },
    },
    async (args) =>
      guard(async () => {
        const parsed = parseDecklist(args.lines);
        if (parsed.entries.length === 0) {
          return textResult("No card lines recognized — expected TCG Live lines like `4 Jacinthe POR 75`.", true);
        }
        const marks = currentLegalMarks();
        const accepted: LineSpec[] = [];
        const understood: string[] = [];
        const rejected: string[] = [];

        const positive = parsed.entries.filter((e) => e.count > 0);
        for (const e of parsed.entries.filter((e) => e.count <= 0)) {
          rejected.push(`✗ Line ${e.line} \`${e.raw}\` — count ${e.count}; not added.`);
        }
        const withCode = positive.filter((e) => e.setCode && e.number);
        const nameOnly = positive.filter((e) => !(e.setCode && e.number));

        // Set-code lines resolve in batch; anything that only resolved via the
        // name fallback is rejected rather than silently added as a guess.
        const resolutions = await resolveEntries(withCode, api, resolver, marks);
        for (const r of resolutions) {
          if (r.card && r.via === "set-code") {
            accepted.push({ count: r.entry.count, name: r.card.name, setCode: r.entry.setCode, number: r.entry.number });
            understood.push(`✓ ${r.entry.count} × ${r.card.name} — ${setRef(r.card)} · ${standardBadge(r.card, marks)} · \`${r.card.id}\``);
          } else {
            const why = r.notes.length > 0 ? r.notes.join("; ") : "not found on pokemontcg.io";
            rejected.push(`✗ Line ${r.entry.line} \`${r.entry.raw}\` — ${why}; not added.`);
          }
        }

        // Reverse set.id → Live code map for printings whose embedded
        // ptcgoCode is missing (a known API data gap).
        const codeOfSet = await resolver.reverseMapping();

        for (const e of nameOnly) {
          if (looksLikeBasicEnergy(e.name)) {
            accepted.push({ count: e.count, name: e.name });
            understood.push(`✓ ${e.count} × ${e.name} (basic energy — stored by name)`);
            continue;
          }
          const res = await api.searchCards(`name:${quoteValue(e.name)}`, { orderBy: "-set.releaseDate", pageSize: 100 });
          const classified = classifyNameOnlyAdd(e, res.cards, (setId) => codeOfSet.get(setId));
          if (classified.outcome === "not-found") {
            rejected.push(`✗ "${e.name}" — no card with that exact name; not added. Try search_cards for the spelling.`);
          } else if (classified.outcome === "ambiguous") {
            const candidates = classified.candidates!;
            const shown = candidates.slice(0, 8);
            rejected.push(
              [
                `✗ "${e.name}" is ambiguous (${candidates.length} printings) — no change made. Add a set code and number; candidates:`,
                ...shown.map((c) => `  - ${setRef(c)} · reg ${c.regulationMark ?? "–"} · ${standardBadge(c, marks)} · \`${c.id}\``),
                ...(candidates.length > shown.length ? [`  - … and ${candidates.length - shown.length} more (see price_check)`] : []),
              ].join("\n"),
            );
          } else {
            const spec = classified.spec!;
            accepted.push(spec);
            understood.push(
              `✓ ${spec.count} × ${spec.name} — only printing is ${spec.setCode ? `${spec.setCode} ${spec.number}` : "(set code unknown — stored by name)"}`,
            );
          }
        }

        let fileNotes: string[] = [];
        if (accepted.length > 0) {
          const path = collectionFilePath();
          const text = await loadCollectionText(path);
          const result = addToCollectionText(text, accepted);
          await saveCollectionText(path, result.text.endsWith("\n") || result.text === "" ? result.text : result.text + "\n");
          fileNotes = result.notes;
        }

        const lines = [`## collection_add — ${parsed.entries.length} line(s) processed`];
        if (understood.length > 0) lines.push("### Added", ...understood, ...fileNotes.map((n) => `- ${n}`));
        if (rejected.length > 0) lines.push("### Not added", ...rejected);
        return textResult(lines.join("\n"));
      }),
  );

  // ---------------------------------------------------------- collection_remove
  server.registerTool(
    "collection_remove",
    {
      title: "Remove cards from the collection",
      description:
        "Decrement or drop cards in the collection file, matched against the file itself (no API). " +
        "A bare name matching several printings in the file is ambiguous and changes nothing; " +
        "over-removal clamps to zero with a note.",
      inputSchema: {
        lines: z.string().describe("Card lines to remove, e.g. '1 Slowpoke PBL 29' or '2 Jacinthe'"),
      },
    },
    async (args) =>
      guard(async () => {
        const parsed = parseDecklist(args.lines);
        if (parsed.entries.length === 0) {
          return textResult("No card lines recognized — expected TCG Live lines like `1 Slowpoke PBL 29`.", true);
        }
        const path = collectionFilePath();
        const text = await loadCollectionText(path);
        if (text.trim() === "") {
          return textResult(`Collection file \`${path}\` is empty or missing — nothing to remove.`, true);
        }
        const specs: LineSpec[] = parsed.entries.map((e) => ({
          count: e.count,
          name: e.name,
          setCode: e.setCode,
          number: e.number,
        }));
        const { text: newText, notes } = removeFromCollectionText(text, specs);
        if (newText !== text) await saveCollectionText(path, newText);
        return textResult([`## collection_remove`, ...notes.map((n) => `- ${n}`)].join("\n"));
      }),
  );
}
