/**
 * Deck rule checks shared by check_deck and build_decks: exact size, ≤4
 * copies per name (basic energy exempt), ≤1 ACE SPEC, per-card standard
 * legality (skippable for unrestricted home play), unresolved lines.
 */
import { countByName, looksLikeBasicEnergy } from "./deck.js";
import { isAceSpec, isBasicEnergy, isStandardLegal } from "./legality.js";
import { setRef } from "./format.js";
import type { Resolution } from "./resolve.js";

export interface DeckRuleOptions {
  deckSize: number;
  marks: string[];
  /** Unrestricted/home play: skip regulation-mark legality (copy limits still apply). */
  ignoreRegulation?: boolean;
}

export function deckProblems(resolutions: Resolution[], totalCards: number, opts: DeckRuleOptions): string[] {
  const problems: string[] = [];
  if (totalCards !== opts.deckSize) {
    const kind = opts.deckSize === 60 ? "standard" : `${opts.deckSize}-card`;
    problems.push(`Deck has **${totalCards}** cards — a ${kind} deck must have exactly ${opts.deckSize}.`);
  }

  const isEnergyRes = (r: Resolution) => (r.card ? isBasicEnergy(r.card) : looksLikeBasicEnergy(r.entry.name));
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
    if (!opts.ignoreRegulation && r.card && !isStandardLegal(r.card, opts.marks)) {
      const reason = r.card.regulationMark
        ? `regulation mark ${r.card.regulationMark} is rotated (legal: ${opts.marks.join(", ")})`
        : "no regulation mark";
      problems.push(`**“${r.entry.name}”** (${setRef(r.card)}) is not standard-legal — ${reason}.`);
    }
    if (!r.card) {
      problems.push(`Could not resolve **“${r.entry.name}”** (line ${r.entry.line}) — legality and price unchecked.`);
    }
  }

  return problems;
}
