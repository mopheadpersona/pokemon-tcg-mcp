/**
 * Local text-pattern detectors over full card objects — the deck builder's and
 * counter-scorer's "effect eyes". Same spirit as find_similar_effects' keyword
 * machinery, but running on already-fetched cards: no API calls. Pure
 * functions — unit tested in test/effects.test.ts.
 *
 * Patterns target modern English card templating ("Your opponent's Active
 * Pokémon is now Poisoned.", "Search your deck for …"). They are heuristics:
 * good enough to classify roles and matchup signals, not a rules engine.
 */
import type { Attack, Card } from "./types.js";

/** All attack/ability/rules text of a card, joined and lowercased. */
export function combinedText(card: Card): string {
  return [
    ...(card.attacks ?? []).map((a) => a.text ?? ""),
    ...(card.abilities ?? []).map((a) => a.text),
    ...(card.rules ?? []),
  ]
    .join(" ")
    .toLowerCase();
}

/** Numeric prefix of a damage string ("70+", "50×" → 70, 50); 0 if none. */
export function parseDamage(damage?: string): number {
  const m = /^(\d+)/.exec((damage ?? "").trim());
  return m ? Number(m[1]) : 0;
}

/** Highest numeric attack damage on the card (0 if it has no attacks). */
export function maxAttackDamage(card: Card): number {
  return Math.max(0, ...(card.attacks ?? []).map((a) => parseDamage(a.damage)));
}

/** The attack a deck actually powers up: the card's highest-damage one. */
export function bestAttack(card: Card): Attack | undefined {
  return (card.attacks ?? []).slice().sort((a, b) => parseDamage(b.damage) - parseDamage(a.damage))[0];
}

export function attackCost(attack: Attack): number {
  return attack.convertedEnergyCost ?? attack.cost?.length ?? 0;
}

function isTrainer(card: Card): boolean {
  return card.supertype?.toLowerCase() === "trainer";
}

function hasSubtype(card: Card, subtype: string): boolean {
  return (card.subtypes ?? []).some((s) => s.toLowerCase() === subtype.toLowerCase());
}

/** Supporter whose effect draws the player cards. */
export function isDrawSupporter(card: Card): boolean {
  return isTrainer(card) && hasSubtype(card, "Supporter") && /\bdraws?\b/.test(combinedText(card));
}

/** Trainer that searches the deck (ball items, evolution search, …). */
export function isSearchItem(card: Card): boolean {
  return isTrainer(card) && /search your deck/.test(combinedText(card));
}

/** Trainer that switches/promotes your own Active Pokémon. */
export function isSwitchCard(card: Card): boolean {
  return isTrainer(card) && /switch your active pok/.test(combinedText(card));
}

/** Trainer that heals damage. */
export function isHealingCard(card: Card): boolean {
  return isTrainer(card) && /\bheal\b/.test(combinedText(card));
}

/** Pokémon Tool card. */
export function isPokemonTool(card: Card): boolean {
  return isTrainer(card) && (card.subtypes ?? []).some((s) => /tool/i.test(s));
}

const CONDITIONS = "(asleep|burned|confused|paralyzed|poisoned)";
const INFLICT_RE = new RegExp(`(opponent's active pok[eé]mon|defending pok[eé]mon)[^.]{0,60} now ${CONDITIONS}`);

/** Attack/ability that inflicts a Special Condition on the opponent. */
export function inflictsSpecialConditions(card: Card): boolean {
  return INFLICT_RE.test(combinedText(card));
}

/** Card whose text removes or prevents Special Conditions. */
export function curesSpecialConditions(card: Card): boolean {
  const text = combinedText(card);
  if (!text.includes("special condition")) return false;
  return /(remove|recover|heal|prevent|can't be|cannot be|won't be|no longer)/.test(text);
}

/** Attack/ability/trainer that discards or removes the opponent's energy. */
export function discardsOpponentEnergy(card: Card): boolean {
  // Segment per sentence so "discard 2 cards from your hand" in one sentence
  // never pairs with an "opponent" in another.
  for (const sentence of combinedText(card).split(".")) {
    const discardsEnergy = /discard(s|ed)?\b[^]*energy|energy[^]*discard/.test(sentence) || /remove\b[^]*energy/.test(sentence);
    if (discardsEnergy && /(opponent|defending)/.test(sentence)) return true;
  }
  return false;
}

/** Attack that damages (or places counters on) the opponent's bench. */
export function hasBenchDamage(card: Card): boolean {
  for (const sentence of combinedText(card).split(".")) {
    if (/opponent's benched/.test(sentence) && /damage/.test(sentence)) return true;
    if (/damage counters? on your opponent's pok/.test(sentence)) return true;
  }
  return false;
}

/** Ability Pokémon that contributes from the bench (no meaningful attacks). */
export function isBenchSitter(card: Card): boolean {
  if (card.supertype !== "Pokémon" || (card.abilities ?? []).length === 0) return false;
  return maxAttackDamage(card) < 30;
}

/** Aura that protects benched Pokémon from damage/effects. */
export function hasBenchProtection(card: Card): boolean {
  for (const sentence of combinedText(card).split(".")) {
    if (/benched pok/.test(sentence) && /(prevent all|protected|no damage|can't be damaged)/.test(sentence)) return true;
  }
  return false;
}

/** Built-in energy acceleration (attach energy from deck/discard as an effect). */
export function hasEnergyAcceleration(card: Card): boolean {
  for (const sentence of combinedText(card).split(".")) {
    if (/attach\b[^]*energy[^]*from your (deck|discard pile)/.test(sentence)) return true;
  }
  return false;
}

/** Gives up more than one prize when knocked out (ex/V/Mega rules text). */
export function isMultiPrize(card: Card): boolean {
  if (card.supertype !== "Pokémon") return false;
  const multiSubtypes = ["ex", "v", "vmax", "vstar", "gx", "tag team"];
  if ((card.subtypes ?? []).some((s) => multiSubtypes.includes(s.toLowerCase()))) return true;
  return /takes? [0-9]+ prize cards/.test(combinedText(card));
}
