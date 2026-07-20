/**
 * Counter-score between two decks: how hard one deck counters the other,
 * from five weighted components (each 0–10). The total is the weighted
 * average, so it stays on a 0–10 scale: <3 balanced, 3–6 playable, >6
 * rebuild recommended. Detection runs on the decks' own card objects via the
 * effects.ts pattern detectors — no API calls. Unit tested in
 * test/counterscore.test.ts.
 */
import {
  attackCost,
  bestAttack,
  curesSpecialConditions,
  discardsOpponentEnergy,
  hasBenchDamage,
  hasBenchProtection,
  hasEnergyAcceleration,
  inflictsSpecialConditions,
  isBenchSitter,
  maxAttackDamage,
  parseDamage,
} from "./effects.js";
import type { Card } from "./types.js";

export interface DeckForScore {
  label: string;
  cards: { card: Card; count: number }[];
}

export interface ComponentResult {
  id: number;
  name: string;
  weight: number;
  /** 0–10. */
  score: number;
  triggered: boolean;
  /** One-line explanation when triggered, "" otherwise. */
  explanation: string;
  /** Cards to swap to defuse the component, per deck label. */
  offenders: { deck: string; names: string[] }[];
}

export interface CounterScoreResult {
  components: ComponentResult[];
  /** Weighted average of the components, 0–10. */
  total: number;
  verdict: string;
}

/** Copy-weighted list of a deck's main attackers (support Pokémon excluded). */
export function mainAttackers(cards: { card: Card; count: number }[]): { card: Card; count: number }[] {
  const pokemon = cards.filter((c) => c.card.supertype === "Pokémon" && !isBenchSitter(c.card));
  const heavy = pokemon.filter((c) => maxAttackDamage(c.card) >= 50);
  if (heavy.length > 0) return heavy;
  return pokemon.filter((c) => (c.card.attacks ?? []).length > 0);
}

function copies(list: { count: number }[]): number {
  return list.reduce((sum, c) => sum + c.count, 0);
}

/** Copy-weighted average energy cost of the main attackers' best attacks. */
function averageAttackCost(attackers: { card: Card; count: number }[]): number {
  let cost = 0;
  let n = 0;
  for (const a of attackers) {
    const attack = bestAttack(a.card);
    if (!attack) continue;
    cost += attackCost(attack) * a.count;
    n += a.count;
  }
  return n === 0 ? 0 : cost / n;
}

/** Earliest realistic turn for a 100+ damage attack (1 attachment/turn, −1 with built-in acceleration). */
function powerTurn(deck: DeckForScore): number {
  const SLOW_CAP = 6;
  let minCost = Infinity;
  for (const { card } of deck.cards) {
    if (card.supertype !== "Pokémon") continue;
    for (const attack of card.attacks ?? []) {
      if (parseDamage(attack.damage) >= 100) minCost = Math.min(minCost, attackCost(attack));
    }
  }
  if (!Number.isFinite(minCost)) return SLOW_CAP;
  const accelerated = deck.cards.some((c) => hasEnergyAcceleration(c.card));
  return Math.min(SLOW_CAP, Math.max(1, minCost - (accelerated ? 1 : 0)));
}

interface Direction {
  attacker: DeckForScore;
  defender: DeckForScore;
}

function distinctNames(list: { card: Card }[]): string[] {
  return [...new Set(list.map((c) => c.card.name))];
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function counterScore(a: DeckForScore, b: DeckForScore): CounterScoreResult {
  const attackersOf = new Map<DeckForScore, { card: Card; count: number }[]>([
    [a, mainAttackers(a.cards)],
    [b, mainAttackers(b.cards)],
  ]);
  const directions: Direction[] = [
    { attacker: a, defender: b },
    { attacker: b, defender: a },
  ];
  const components: ComponentResult[] = [];

  // ---- 1. Weakness exploitation (weight 3): score the worse direction.
  {
    let best = { score: 0, explanation: "", offenders: [] as ComponentResult["offenders"] };
    for (const { attacker, defender } of directions) {
      const atkTypes = new Set(attackersOf.get(attacker)!.flatMap((c) => c.card.types ?? []));
      const defenders = attackersOf.get(defender)!;
      const total = copies(defenders);
      const weak = defenders.filter((d) => (d.card.weaknesses ?? []).some((w) => atkTypes.has(w.type)));
      const frac = total === 0 ? 0 : copies(weak) / total;
      const score = 10 * frac;
      if (score > best.score) {
        const weakTypes = [...new Set(weak.flatMap((d) => (d.card.weaknesses ?? []).filter((w) => atkTypes.has(w.type)).map((w) => w.type)))];
        best = {
          score,
          explanation:
            `${copies(weak)}/${total} of ${defender.label}'s attacker copies are ${weakTypes.join("/")}-weak, ` +
            `and ${attacker.label} attacks with exactly that type (${distinctNames(weak).join(", ")}).`,
          offenders: [{ deck: defender.label, names: distinctNames(weak) }],
        };
      }
    }
    components.push({
      id: 1,
      name: "Weakness exploitation",
      weight: 3,
      score: round1(best.score),
      triggered: best.score > 0,
      explanation: best.score > 0 ? best.explanation : "",
      offenders: best.offenders,
    });
  }

  // ---- 2. Status execution vs no cure (weight 2).
  {
    let best = { score: 0, explanation: "", offenders: [] as ComponentResult["offenders"] };
    for (const { attacker, defender } of directions) {
      const inflicters = attacker.cards.filter((c) => inflictsSpecialConditions(c.card));
      const cures = defender.cards.filter((c) => curesSpecialConditions(c.card));
      if (inflicters.length === 0 || cures.length > 0) continue;
      const sources = distinctNames(inflicters);
      const score = sources.length >= 2 ? 10 : 6;
      if (score > best.score) {
        best = {
          score,
          explanation:
            `${attacker.label} inflicts Special Conditions (${sources.join(", ")}) and ` +
            `${defender.label} runs zero cards that remove or prevent Special Conditions.`,
          offenders: [{ deck: attacker.label, names: sources }],
        };
      }
    }
    components.push({
      id: 2,
      name: "Status vs no cure",
      weight: 2,
      score: best.score,
      triggered: best.score > 0,
      explanation: best.explanation,
      offenders: best.offenders,
    });
  }

  // ---- 3. Energy denial vs expensive attacks (weight 2).
  {
    let best = { score: 0, explanation: "", offenders: [] as ComponentResult["offenders"] };
    for (const { attacker, defender } of directions) {
      const deniers = attacker.cards.filter((c) => discardsOpponentEnergy(c.card));
      const avgCost = averageAttackCost(attackersOf.get(defender)!);
      if (deniers.length === 0 || avgCost < 3) continue;
      const score = Math.min(10, (avgCost - 2) * 5);
      if (score > best.score) {
        best = {
          score,
          explanation:
            `${attacker.label} discards opponent energy (${distinctNames(deniers).join(", ")}) while ` +
            `${defender.label}'s attacks average ${round1(avgCost)} energy — every discard sets it back a full turn.`,
          offenders: [{ deck: attacker.label, names: distinctNames(deniers) }],
        };
      }
    }
    components.push({
      id: 3,
      name: "Energy denial vs expensive attacks",
      weight: 2,
      score: round1(best.score),
      triggered: best.score > 0,
      explanation: best.explanation,
      offenders: best.offenders,
    });
  }

  // ---- 4. Snipe/spread vs bench reliance (weight 2).
  {
    let best = { score: 0, explanation: "", offenders: [] as ComponentResult["offenders"] };
    for (const { attacker, defender } of directions) {
      const snipers = attacker.cards.filter((c) => hasBenchDamage(c.card));
      const benchPieces = defender.cards.filter(
        (c) => c.card.supertype === "Pokémon" && (isBenchSitter(c.card) || hasBenchProtection(c.card)),
      );
      if (snipers.length === 0 || benchPieces.length === 0) continue;
      const score = Math.min(10, 2.5 * copies(benchPieces));
      if (score > best.score) {
        best = {
          score,
          explanation:
            `${attacker.label} hits the bench (${distinctNames(snipers).join(", ")}) and ${defender.label} ` +
            `leans on ${copies(benchPieces)} bench-sitting support copies (${distinctNames(benchPieces).join(", ")}).`,
          offenders: [
            { deck: attacker.label, names: distinctNames(snipers) },
            { deck: defender.label, names: distinctNames(benchPieces) },
          ],
        };
      }
    }
    components.push({
      id: 4,
      name: "Snipe vs bench reliance",
      weight: 2,
      score: round1(best.score),
      triggered: best.score > 0,
      explanation: best.explanation,
      offenders: best.offenders,
    });
  }

  // ---- 5. Tempo mismatch (weight 1).
  {
    const ta = powerTurn(a);
    const tb = powerTurn(b);
    const diff = Math.abs(ta - tb);
    const score = Math.min(10, diff * 2.5);
    const slow = ta > tb ? a : b;
    components.push({
      id: 5,
      name: "Tempo mismatch",
      weight: 1,
      score: round1(score),
      triggered: score > 0,
      explanation:
        score > 0
          ? `${a.label} powers a 100+ damage attack around turn ${ta}, ${b.label} around turn ${tb} — ` +
            `${slow.label} spends its opening turns catching up.`
          : "",
      offenders: score > 0 ? [{ deck: slow.label, names: distinctNames(mainAttackers(slow.cards)) }] : [],
    });
  }

  const weightSum = components.reduce((s, c) => s + c.weight, 0);
  const total = round1(components.reduce((s, c) => s + c.weight * c.score, 0) / weightSum);

  let verdict: string;
  if (total < 3) {
    verdict = "balanced pair";
  } else {
    const worst = components
      .filter((c) => c.triggered)
      .sort((x, y) => y.weight * y.score - x.weight * x.score)[0];
    if (total <= 6) {
      verdict = `playable, note ${worst ? worst.name.toLowerCase() : "the breakdown"}`;
    } else {
      const swaps = worst?.offenders.map((o) => `${o.names.join(", ")} (${o.deck})`).join("; ");
      verdict = `rebuild recommended — swap ${swaps ?? "the flagged cards"}`;
    }
  }

  return { components, total, verdict };
}
