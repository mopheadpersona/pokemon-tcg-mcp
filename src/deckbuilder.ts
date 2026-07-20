/**
 * Deterministic deck-building engine over an owned-card pool. No LLM calls,
 * no API calls — it works on cards already resolved from the collection.
 * Unit tested in test/deckbuilder.test.ts.
 *
 * Pipeline: group Pokémon into evolution lines (evolvesFrom) → score lines
 * as attacker cores → assemble around the best core (starters, draw, search,
 * switch, energy, leftovers) to the exact deck size → for pairs, iterate on
 * the counter-score by excluding offender cards and rebuilding.
 */
import { counterScore, mainAttackers, type CounterScoreResult, type DeckForScore } from "./counterscore.js";
import { normalizeName } from "./deck.js";
import {
  attackCost,
  bestAttack,
  isDrawSupporter,
  isHealingCard,
  isMultiPrize,
  isPokemonTool,
  isSearchItem,
  isSwitchCard,
  maxAttackDamage,
} from "./effects.js";
import { isAceSpec, isBasicEnergy, isStandardLegal } from "./legality.js";
import type { Card } from "./types.js";

export interface OwnedCard {
  card: Card;
  count: number;
}

export interface EvolutionLine {
  /** stages[0] = basics, stages[1] = stage 1 evolutions, … */
  stages: OwnedCard[][];
  /** Highest-damage card in the line. */
  topAttacker: Card;
  /** Non-colorless energy types across the line's attack costs. */
  energyTypes: string[];
  hasAbility: boolean;
  score: number;
  /** Human-readable scoring notes. */
  reasons: string[];
}

export interface Guidelines {
  minBasics: number;
  draw: [number, number];
  search: [number, number];
  switch: [number, number];
  energy: [number, number];
}

export interface BuildOptions {
  deckSize: 40 | 60;
  format: "standard" | "unrestricted";
  /** Regulation marks currently legal (ignored for unrestricted). */
  legalMarks: string[];
  mustInclude?: string[];
  /** Normalized names banned from this build (counter-balance iteration). */
  exclude?: Set<string>;
}

export interface DeckCard {
  card: Card;
  count: number;
  role: string;
}

export interface BuiltDeck {
  cards: DeckCard[];
  total: number;
  coreLines: EvolutionLine[];
  attackers: Card[];
  energyTypes: string[];
  counts: { basics: number; draw: number; search: number; switch: number; energy: number };
  strategy: string;
  weaknesses: string[];
  warnings: string[];
}

/** Category targets per deck size; 40-card play scales the 60-card numbers by 2/3. */
export function guidelines(deckSize: 40 | 60): Guidelines {
  if (deckSize === 60) {
    return { minBasics: 8, draw: [6, 10], search: [4, 8], switch: [2, 4], energy: [12, 15] };
  }
  return { minBasics: 6, draw: [4, 7], search: [3, 5], switch: [1, 3], energy: [8, 10] };
}

function isBasicPokemon(card: Card): boolean {
  if (card.supertype !== "Pokémon") return false;
  const subtypes = card.subtypes ?? [];
  if (subtypes.some((s) => s.toLowerCase() === "basic")) return true;
  // Live data gap: some printings (e.g. Mankey me5-42) ship without subtypes.
  // No evolvesFrom and no stage marker means it can start in play.
  return !card.evolvesFrom && !subtypes.some((s) => /stage/i.test(s));
}

function scoreLine(stages: OwnedCard[][]): EvolutionLine {
  const all = stages.flat();
  let topAttacker = all[0].card;
  let topDamage = -1;
  for (const o of all) {
    const dmg = maxAttackDamage(o.card);
    if (dmg > topDamage) {
      topDamage = dmg;
      topAttacker = o.card;
    }
  }
  topDamage = Math.max(0, topDamage);
  const attack = bestAttack(topAttacker);
  const cost = attack ? Math.max(1, attackCost(attack)) : 1;
  const energyTypes = [
    ...new Set(all.flatMap((o) => (o.card.attacks ?? []).flatMap((a) => a.cost ?? []))),
  ].filter((t) => t !== "Colorless");
  const hasAbility = all.some((o) => (o.card.abilities ?? []).length > 0);
  const hp = Number(topAttacker.hp ?? 0) || 0;
  const multiPrize = isMultiPrize(topAttacker);
  const playable = stages[0].some((o) => !o.card.evolvesFrom);

  let score = topDamage * 0.5 + (topDamage / cost) * 0.6 + hp * 0.08 + (hasAbility ? 12 : 0) - (multiPrize ? 8 : 0);
  const reasons = [`${topDamage} damage for ${cost} energy`, `${hp} HP`];
  if (hasAbility) reasons.push("ability support");
  if (multiPrize) reasons.push("gives up extra prizes");
  if (!playable) {
    score -= 1000;
    reasons.push("missing its Basic — unplayable line");
  }
  return { stages, topAttacker, energyTypes, hasAbility, score, reasons };
}

/** Group owned Pokémon into evolution lines via evolvesFrom, scored as cores. */
export function groupEvolutionLines(pokemon: OwnedCard[]): EvolutionLine[] {
  interface Group {
    name: string;
    members: OwnedCard[];
    evolvesFrom?: string;
  }
  const groups = new Map<string, Group>();
  for (const o of pokemon) {
    if (o.count <= 0) continue;
    const key = normalizeName(o.card.name);
    const group = groups.get(key) ?? { name: o.card.name, members: [] };
    group.members.push(o);
    group.evolvesFrom = group.evolvesFrom ?? o.card.evolvesFrom;
    groups.set(key, group);
  }

  const childrenOf = new Map<string, string[]>();
  for (const [key, group] of groups) {
    const parent = group.evolvesFrom ? normalizeName(group.evolvesFrom) : undefined;
    if (parent && groups.has(parent)) {
      const children = childrenOf.get(parent) ?? [];
      children.push(key);
      childrenOf.set(parent, children);
    }
  }

  const roots = [...groups.keys()].filter((key) => {
    const parent = groups.get(key)!.evolvesFrom;
    return !parent || !groups.has(normalizeName(parent));
  });

  const lines: EvolutionLine[] = [];
  for (const root of roots) {
    const stages: OwnedCard[][] = [];
    const seen = new Set<string>();
    let frontier = [root];
    while (frontier.length > 0) {
      const stage: OwnedCard[] = [];
      const next: string[] = [];
      for (const key of frontier) {
        if (seen.has(key)) continue;
        seen.add(key);
        stage.push(...groups.get(key)!.members);
        next.push(...(childrenOf.get(key) ?? []));
      }
      if (stage.length > 0) stages.push(stage);
      frontier = next;
    }
    lines.push(scoreLine(stages));
  }
  return lines;
}

function isPlayableLine(line: EvolutionLine): boolean {
  return line.score > 0 && line.stages[0].some((o) => !o.card.evolvesFrom);
}

function lineNames(line: EvolutionLine): Set<string> {
  return new Set(line.stages.flat().map((o) => normalizeName(o.card.name)));
}

/** Deck assembly state: enforces owned counts, ≤4 per name, ≤1 ACE SPEC, exact budget. */
class Assembly {
  readonly deck = new Map<string, DeckCard>();
  total = 0;
  private nameUsed = new Map<string, number>();
  private aceUsed = 0;
  private avail = new Map<string, number>();

  constructor(
    pool: { card: Card; available: number }[],
    private budget: number,
  ) {
    for (const e of pool) this.avail.set(e.card.id, e.available);
  }

  available(card: Card): number {
    return this.avail.get(card.id) ?? 0;
  }

  add(card: Card, want: number, role: string): number {
    if (want <= 0) return 0;
    let can = Math.min(want, this.available(card), this.budget - this.total);
    const nameKey = normalizeName(card.name);
    if (!isBasicEnergy(card)) can = Math.min(can, 4 - (this.nameUsed.get(nameKey) ?? 0));
    if (isAceSpec(card)) can = Math.min(can, 1 - this.aceUsed);
    if (can <= 0) return 0;

    this.avail.set(card.id, this.available(card) - can);
    this.nameUsed.set(nameKey, (this.nameUsed.get(nameKey) ?? 0) + can);
    if (isAceSpec(card)) this.aceUsed += can;
    this.total += can;
    const existing = this.deck.get(card.id);
    if (existing) existing.count += can;
    else this.deck.set(card.id, { card, count: can, role });
    return can;
  }

  cards(): DeckCard[] {
    return [...this.deck.values()];
  }

  copiesWhere(pred: (card: Card) => boolean): number {
    return this.cards()
      .filter((c) => pred(c.card))
      .reduce((sum, c) => sum + c.count, 0);
  }
}

interface PoolEntry {
  card: Card;
  available: number;
}

function byAvailabilityThenName(a: PoolEntry, b: PoolEntry): number {
  return b.available - a.available || a.card.name.localeCompare(b.card.name);
}

/** Build one deck from the pool. Best-effort: short pools yield a smaller deck plus warnings. */
export function buildDeck(owned: OwnedCard[], opts: BuildOptions): BuiltDeck | null {
  const g = guidelines(opts.deckSize);
  const warnings: string[] = [];
  const excluded = opts.exclude ?? new Set<string>();

  // Merge printings by card id; filter to what this format may use.
  const byId = new Map<string, PoolEntry>();
  for (const o of owned) {
    if (o.count <= 0) continue;
    if (opts.format === "standard" && !isStandardLegal(o.card, opts.legalMarks)) continue;
    if (excluded.has(normalizeName(o.card.name))) continue;
    const entry = byId.get(o.card.id);
    if (entry) entry.available += o.count;
    else byId.set(o.card.id, { card: o.card, available: o.count });
  }
  const pool = [...byId.values()];
  const pokemon = pool.filter((e) => e.card.supertype === "Pokémon");
  const trainers = pool.filter((e) => e.card.supertype === "Trainer");
  const energies = pool.filter((e) => e.card.supertype === "Energy");

  const mustNames = new Set((opts.mustInclude ?? []).map(normalizeName));
  for (const must of mustNames) {
    if (!pool.some((e) => normalizeName(e.card.name) === must)) {
      warnings.push(`must_include "${must}" is not available in the usable collection.`);
    }
  }

  const lines = groupEvolutionLines(pokemon.map((e) => ({ card: e.card, count: e.available })));
  const playable = lines.filter(isPlayableLine);
  if (playable.length === 0) return null;

  const hasMust = (line: EvolutionLine) => [...lineNames(line)].some((n) => mustNames.has(n));
  const ranked = playable
    .slice()
    .sort(
      (a, b) =>
        (hasMust(b) ? 1_000_000 : 0) + b.score - ((hasMust(a) ? 1_000_000 : 0) + a.score) ||
        a.topAttacker.name.localeCompare(b.topAttacker.name),
    );

  const primary = ranked[0];
  const coreLines = [primary];
  const sharesType = (line: EvolutionLine) =>
    line.energyTypes.length === 0 ||
    primary.energyTypes.length === 0 ||
    line.energyTypes.some((t) => primary.energyTypes.includes(t));
  const secondary = ranked.slice(1).find((l) => hasMust(l) || sharesType(l) || l.hasAbility);
  if (secondary) coreLines.push(secondary);
  // must_include lines always join the core, even as a third line.
  for (const line of ranked) {
    if (!coreLines.includes(line) && hasMust(line)) coreLines.push(line);
  }

  const asm = new Assembly(pool, opts.deckSize);
  // Reserve room for the trainer/energy minimums so a fat core can't eat the whole deck.
  const coreCap = opts.deckSize - (g.draw[0] + g.search[0] + g.switch[0] + g.energy[0]);

  // ---- core lines, evolution-ratio counts (never more evolutions than the stage below)
  for (const line of coreLines) {
    let prevStage = Infinity;
    for (const stage of line.stages) {
      const stageTarget = Math.min(4, prevStage);
      let added = 0;
      for (const o of stage.slice().sort((a, b) => b.count - a.count || a.card.name.localeCompare(b.card.name))) {
        if (asm.total >= coreCap) break;
        added += asm.add(o.card, Math.min(stageTarget - added, o.count), "core");
      }
      prevStage = added;
      if (added === 0) break;
    }
  }

  // ---- starter basics up to the mulligan threshold
  const coreTypes = [...new Set(coreLines.flatMap((l) => l.energyTypes))];
  if (asm.copiesWhere(isBasicPokemon) < g.minBasics) {
    const starterCandidates = pokemon
      .filter((e) => isBasicPokemon(e.card))
      .slice()
      .sort((a, b) => {
        const typeMatch = (e: PoolEntry) => ((e.card.types ?? []).some((t) => coreTypes.includes(t)) ? 1 : 0);
        const ability = (e: PoolEntry) => ((e.card.abilities ?? []).length > 0 ? 1 : 0);
        return (
          typeMatch(b) - typeMatch(a) ||
          ability(b) - ability(a) ||
          maxAttackDamage(b.card) - maxAttackDamage(a.card) ||
          a.card.name.localeCompare(b.card.name)
        );
      });
    for (const e of starterCandidates) {
      const deficit = g.minBasics - asm.copiesWhere(isBasicPokemon);
      if (deficit <= 0) break;
      asm.add(e.card, deficit, "starter");
    }
  }

  // ---- trainer categories (first matching category wins per card)
  const drawCards = trainers.filter((e) => isDrawSupporter(e.card)).sort(byAvailabilityThenName);
  const searchCards = trainers
    .filter((e) => !isDrawSupporter(e.card) && isSearchItem(e.card))
    .sort(byAvailabilityThenName);
  const switchCards = trainers
    .filter((e) => !isDrawSupporter(e.card) && !isSearchItem(e.card) && isSwitchCard(e.card))
    .sort(byAvailabilityThenName);
  const categorized = new Set([...drawCards, ...searchCards, ...switchCards].map((e) => e.card.id));
  const healCards = trainers
    .filter((e) => !categorized.has(e.card.id) && isHealingCard(e.card))
    .sort(byAvailabilityThenName);
  const toolCards = trainers
    .filter((e) => !categorized.has(e.card.id) && !isHealingCard(e.card) && isPokemonTool(e.card))
    .sort(byAvailabilityThenName);
  const restTrainers = trainers
    .filter((e) => !categorized.has(e.card.id) && !isHealingCard(e.card) && !isPokemonTool(e.card))
    .sort(byAvailabilityThenName);

  const roleCounts = { draw: 0, search: 0, switch: 0, energy: 0 };
  const fillCategory = (cards: PoolEntry[], target: number, role: keyof typeof roleCounts) => {
    for (const e of cards) {
      if (roleCounts[role] >= target) break;
      roleCounts[role] += asm.add(e.card, target - roleCounts[role], role);
    }
  };

  fillCategory(drawCards, g.draw[0], "draw");
  fillCategory(searchCards, g.search[0], "search");
  fillCategory(switchCards, g.switch[0], "switch");

  // ---- energy matched to the cores' attack costs
  const deckAttackers = mainAttackers(asm.cards().map((c) => ({ card: c.card, count: c.count })));
  let costSum = 0;
  let costN = 0;
  for (const a of deckAttackers) {
    const attack = bestAttack(a.card);
    if (!attack) continue;
    costSum += attackCost(attack) * a.count;
    costN += a.count;
  }
  const avgCost = costN > 0 ? costSum / costN : 3;
  const energyTarget = Math.min(
    g.energy[1],
    Math.max(g.energy[0], Math.round(avgCost * (opts.deckSize === 60 ? 4.5 : 3))),
  );

  const typeWeights = new Map<string, number>();
  for (const a of deckAttackers) {
    for (const t of new Set((a.card.attacks ?? []).flatMap((atk) => atk.cost ?? []).filter((t) => t !== "Colorless"))) {
      typeWeights.set(t, (typeWeights.get(t) ?? 0) + a.count);
    }
  }
  const desiredTypes = [...typeWeights.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
  const matchesType = (card: Card, type: string) =>
    card.name.toLowerCase().includes(type.toLowerCase()) ||
    (card.rules ?? []).join(" ").toLowerCase().includes(type.toLowerCase());
  const basicEnergies = energies.filter((e) => isBasicEnergy(e.card));
  const specialEnergies = energies.filter((e) => !isBasicEnergy(e.card));
  const energyCandidates: PoolEntry[] = [];
  if (desiredTypes.length === 0) {
    energyCandidates.push(...basicEnergies.slice().sort(byAvailabilityThenName));
  } else {
    for (const type of desiredTypes) {
      energyCandidates.push(...basicEnergies.filter((e) => matchesType(e.card, type)).sort(byAvailabilityThenName));
    }
    // Special energies of a matching type count toward the energy line.
    for (const type of desiredTypes) {
      energyCandidates.push(...specialEnergies.filter((e) => matchesType(e.card, type)).sort(byAvailabilityThenName));
    }
  }
  for (const e of energyCandidates) {
    if (roleCounts.energy >= energyTarget) break;
    roleCounts.energy += asm.add(e.card, energyTarget - roleCounts.energy, "energy");
  }

  // ---- expansion to the exact size: category maxima, then healing/tools/leftovers
  fillCategory(drawCards, Math.min(g.draw[1], opts.deckSize - asm.total + roleCounts.draw), "draw");
  fillCategory(searchCards, Math.min(g.search[1], opts.deckSize - asm.total + roleCounts.search), "search");
  fillCategory(switchCards, Math.min(g.switch[1], opts.deckSize - asm.total + roleCounts.switch), "switch");
  for (const e of healCards) asm.add(e.card, opts.deckSize - asm.total, "heal");
  for (const e of toolCards) asm.add(e.card, opts.deckSize - asm.total, "tool");
  for (const e of restTrainers) asm.add(e.card, opts.deckSize - asm.total, "flex");
  for (const e of energyCandidates) {
    if (roleCounts.energy >= g.energy[1] || asm.total >= opts.deckSize) break;
    roleCounts.energy += asm.add(e.card, Math.min(g.energy[1] - roleCounts.energy, opts.deckSize - asm.total), "energy");
  }

  // ---- last-resort padding: extra basics, then anything usable, then over-guideline energy
  if (asm.total < opts.deckSize) {
    const padPokemon = pokemon.filter((e) => isBasicPokemon(e.card)).sort(byAvailabilityThenName);
    for (const e of padPokemon) asm.add(e.card, opts.deckSize - asm.total, "flex");
    for (const e of pool) asm.add(e.card, opts.deckSize - asm.total, "flex");
    if (asm.total < opts.deckSize) {
      warnings.push(`Collection only supports ${asm.total} of ${opts.deckSize} cards for this deck.`);
    }
  }

  // ---- reporting
  const counts = {
    basics: asm.copiesWhere(isBasicPokemon),
    draw: roleCounts.draw,
    search: roleCounts.search,
    switch: roleCounts.switch,
    energy: asm.copiesWhere((c) => c.supertype === "Energy"),
  };
  const attackers = mainAttackers(asm.cards().map((c) => ({ card: c.card, count: c.count }))).map((c) => c.card);

  const weaknesses: string[] = [];
  const weakTypes = [...new Set(attackers.flatMap((c) => (c.weaknesses ?? []).map((w) => w.type)))];
  if (weakTypes.length > 0) weaknesses.push(`Main attackers are ${weakTypes.join("/")}-weak.`);
  if (counts.basics < g.minBasics) {
    weaknesses.push(`Only ${counts.basics} starting basics (target ${g.minBasics}+) — real mulligan risk.`);
  }
  if (counts.draw < g.draw[0]) weaknesses.push(`Only ${counts.draw} draw supporters (target ${g.draw[0]}–${g.draw[1]}).`);
  if (counts.switch < g.switch[0]) weaknesses.push(`Thin on switch effects (${counts.switch}, target ${g.switch[0]}–${g.switch[1]}).`);
  if (counts.energy < g.energy[0]) weaknesses.push(`Only ${counts.energy} energy (target ${g.energy[0]}–${g.energy[1]}).`);
  if (counts.energy > g.energy[1]) {
    weaknesses.push(`Energy-heavy (${counts.energy} > ${g.energy[1]}) — the pool had nothing better to pad with.`);
  }

  const topAttack = bestAttack(primary.topAttacker);
  const sentences: string[] = [
    `Set up ${primary.topAttacker.name} (${maxAttackDamage(primary.topAttacker)} damage for ${topAttack ? attackCost(topAttack) : "?"} energy) through the ${primary.stages[0][0]?.card.name ?? "?"} line.`,
  ];
  if (secondary) {
    const abilityCard = secondary.stages.flat().find((o) => (o.card.abilities ?? []).length > 0)?.card;
    sentences.push(
      abilityCard
        ? `${abilityCard.name}'s ${abilityCard.abilities![0].name} ability backs the attackers up.`
        : `${secondary.topAttacker.name} adds a second attacking angle.`,
    );
  }
  sentences.push(
    `${counts.energy} ${desiredTypes.length > 0 ? desiredTypes.join("/") + " " : ""}energy and ${counts.draw} draw supporters keep the engine running.`,
  );

  return {
    cards: asm.cards(),
    total: asm.total,
    coreLines,
    attackers,
    energyTypes: desiredTypes,
    counts,
    strategy: sentences.join(" "),
    weaknesses,
    warnings,
  };
}

export interface BuildRequest extends BuildOptions {
  deckCount: 1 | 2;
}

export interface BuildResult {
  decks: BuiltDeck[];
  /** Present when deckCount = 2 and both decks were built. */
  counter?: CounterScoreResult;
  /** Counter-balance iterations used (deckCount = 2). */
  attempts?: number;
  warnings: string[];
}

/** Pool minus the copies a built deck consumed (matched by card id). */
function subtractPool(owned: OwnedCard[], deck: BuiltDeck): OwnedCard[] {
  const used = new Map<string, number>();
  for (const c of deck.cards) used.set(c.card.id, (used.get(c.card.id) ?? 0) + c.count);
  return owned.map((o) => {
    const take = Math.min(o.count, used.get(o.card.id) ?? 0);
    if (take > 0) used.set(o.card.id, used.get(o.card.id)! - take);
    return { card: o.card, count: o.count - take };
  });
}

function toScore(deck: BuiltDeck, label: string): DeckForScore {
  return { label, cards: deck.cards.map((c) => ({ card: c.card, count: c.count })) };
}

const union = (...sets: (Set<string> | undefined)[]): Set<string> => {
  const out = new Set<string>();
  for (const s of sets) for (const v of s ?? []) out.add(v);
  return out;
};

/**
 * Build 1–2 decks from a shared pool (two decks never use more copies of a
 * card than the collection owns). Pairs are rebuilt up to 5 times, excluding
 * the worst counter-score offenders, keeping the best pair seen.
 */
export function buildDecksFromCollection(owned: OwnedCard[], req: BuildRequest): BuildResult {
  const warnings: string[] = [];
  if (req.deckCount === 1) {
    const deck = buildDeck(owned, req);
    if (!deck) {
      return { decks: [], warnings: ["No playable Pokémon lines in the usable collection — cannot build a deck."] };
    }
    return { decks: [deck], warnings };
  }

  // Pre-assign disjoint cores so deck 1's padding can't cannibalize deck 2's line.
  const usablePokemon = owned.filter(
    (o) =>
      o.card.supertype === "Pokémon" &&
      (req.format === "unrestricted" || isStandardLegal(o.card, req.legalMarks)) &&
      !(req.exclude?.has(normalizeName(o.card.name)) ?? false),
  );
  const allLines = groupEvolutionLines(usablePokemon)
    .filter(isPlayableLine)
    .sort((a, b) => b.score - a.score || a.topAttacker.name.localeCompare(b.topAttacker.name));
  const mustNames = new Set((req.mustInclude ?? []).map(normalizeName));
  const coreA = allLines[0];
  const coreB = allLines.find((l) => l !== coreA && ![...lineNames(l)].some((n) => lineNames(coreA).has(n)));
  const reservedFromA = new Set([...(coreB ? lineNames(coreB) : [])].filter((n) => !mustNames.has(n)));
  const reservedFromB = coreA ? lineNames(coreA) : new Set<string>();

  const banA = new Set<string>();
  const banB = new Set<string>();
  let best: { a: BuiltDeck; b: BuiltDeck; counter: CounterScoreResult } | undefined;
  let attempts = 0;

  for (let i = 1; i <= 5; i++) {
    attempts = i;
    const a = buildDeck(owned, { ...req, exclude: union(req.exclude, reservedFromA, banA) });
    if (!a) {
      warnings.push("Could not build the first deck (no playable Pokémon core left).");
      break;
    }
    const b = buildDeck(subtractPool(owned, a), {
      ...req,
      mustInclude: undefined,
      exclude: union(req.exclude, reservedFromB, banB),
    });
    if (!b) {
      if (!best) {
        warnings.push("The collection cannot support a second full deck — built one deck instead.");
        return { decks: [a], warnings };
      }
      break;
    }
    const counter = counterScore(toScore(a, "Deck 1"), toScore(b, "Deck 2"));
    if (!best || counter.total < best.counter.total) best = { a, b, counter };
    if (counter.total < 3) break;

    const worst = counter.components
      .filter((c) => c.triggered)
      .sort((x, y) => y.weight * y.score - x.weight * x.score)[0];
    if (!worst) break;
    let changed = false;
    for (const offender of worst.offenders) {
      const target = offender.deck === "Deck 1" ? banA : banB;
      for (const name of offender.names) {
        const key = normalizeName(name);
        if (!target.has(key)) {
          target.add(key);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }

  if (!best) return { decks: [], warnings };
  return { decks: [best.a, best.b], counter: best.counter, attempts, warnings };
}
