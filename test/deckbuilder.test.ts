import { describe, expect, it } from "vitest";

import {
  buildDeck,
  buildDecksFromCollection,
  groupEvolutionLines,
  guidelines,
  type BuildOptions,
  type BuiltDeck,
  type OwnedCard,
} from "../src/deckbuilder.js";
import { isBasicEnergy } from "../src/legality.js";
import { deckProblems } from "../src/validate.js";
import {
  aromatisse,
  cheerfulTidings,
  eelektrik,
  fightingEnergy,
  fixtureCollection,
  fullHeal,
  lightningEnergy,
  lucario,
  megaSlowbroEx,
  nestBall,
  own,
  potion,
  primeCatcher,
  psychicEnergy,
  rareCandy,
  research,
  riolu,
  slowbro,
  slowpoke,
  sparklingPsychicEnergy,
  spritzee,
  switchCard,
  tynamo,
  ultraBall,
  vitalityBand,
} from "./fixtures.js";

const MARKS = ["H", "I", "J"];
const OPTS: BuildOptions = { deckSize: 60, format: "standard", legalMarks: MARKS };

function countWhere(deck: BuiltDeck, pred: (c: OwnedCard) => boolean): number {
  return deck.cards.filter(pred).reduce((sum, c) => sum + c.count, 0);
}

function basicPokemonCount(deck: BuiltDeck): number {
  return countWhere(
    deck,
    (c) => c.card.supertype === "Pokémon" && (c.card.subtypes ?? []).some((s) => s.toLowerCase() === "basic"),
  );
}

function energyCount(deck: BuiltDeck): number {
  return countWhere(deck, (c) => c.card.supertype === "Energy");
}

describe("groupEvolutionLines", () => {
  it("chains evolvesFrom into multi-stage lines", () => {
    const lines = groupEvolutionLines([
      own(slowpoke, 4),
      own(slowbro, 2),
      own(megaSlowbroEx, 2),
      own(spritzee, 4),
      own(aromatisse, 3),
      own(riolu, 2),
    ]);
    expect(lines).toHaveLength(3);
    const slowLine = lines.find((l) => l.stages[0].some((o) => o.card.name === "Slowpoke"))!;
    expect(slowLine.stages).toHaveLength(3);
    expect(slowLine.stages[1][0].card.name).toBe("Slowbro");
    expect(slowLine.stages[2][0].card.name).toBe("Mega Slowbro ex");
    expect(slowLine.topAttacker.name).toBe("Mega Slowbro ex");
    expect(slowLine.energyTypes).toContain("Psychic");

    const aromaLine = lines.find((l) => l.stages[0].some((o) => o.card.name === "Spritzee"))!;
    expect(aromaLine.stages).toHaveLength(2);
    expect(aromaLine.hasAbility).toBe(true);

    const rioluLine = lines.find((l) => l.stages[0].some((o) => o.card.name === "Riolu"))!;
    expect(rioluLine.stages).toHaveLength(1);
  });

  it("scores the heavy-hitting Mega line above the support line", () => {
    const lines = groupEvolutionLines([
      own(slowpoke, 4),
      own(slowbro, 2),
      own(megaSlowbroEx, 2),
      own(spritzee, 4),
      own(aromatisse, 3),
    ]);
    const slowLine = lines.find((l) => l.topAttacker.name === "Mega Slowbro ex")!;
    const aromaLine = lines.find((l) => l.stages[0].some((o) => o.card.name === "Spritzee"))!;
    expect(slowLine.score).toBeGreaterThan(aromaLine.score);
  });
});

describe("guidelines", () => {
  it("uses the hard-learned 60-card thresholds", () => {
    expect(guidelines(60)).toEqual({
      minBasics: 8,
      draw: [6, 10],
      search: [4, 8],
      switch: [2, 4],
      energy: [12, 15],
    });
  });

  it("scales by 2/3 for 40-card play", () => {
    expect(guidelines(40)).toEqual({
      minBasics: 6,
      draw: [4, 7],
      switch: [1, 3],
      search: [3, 5],
      energy: [8, 10],
    });
  });
});

describe("buildDeck — 60 cards", () => {
  const deck = buildDeck(fixtureCollection(), OPTS)!;

  it("hits exactly 60 cards", () => {
    expect(deck).not.toBeNull();
    expect(deck.total).toBe(60);
    expect(deck.cards.reduce((s, c) => s + c.count, 0)).toBe(60);
  });

  it("meets the mulligan threshold of 8+ basics", () => {
    expect(basicPokemonCount(deck)).toBeGreaterThanOrEqual(8);
  });

  it("keeps draw, switch and energy within guidelines", () => {
    expect(deck.counts.draw).toBeGreaterThanOrEqual(6);
    expect(deck.counts.draw).toBeLessThanOrEqual(10);
    expect(deck.counts.switch).toBeGreaterThanOrEqual(2);
    expect(deck.counts.switch).toBeLessThanOrEqual(4);
    expect(energyCount(deck)).toBeGreaterThanOrEqual(12);
    expect(energyCount(deck)).toBeLessThanOrEqual(15);
  });

  it("respects the 4-copy and ACE SPEC limits", () => {
    for (const c of deck.cards) {
      if (!isBasicEnergy(c.card)) expect(c.count).toBeLessThanOrEqual(4);
    }
    const aceSpecs = deck.cards.filter((c) => (c.card.subtypes ?? []).includes("ACE SPEC"));
    expect(aceSpecs.reduce((s, c) => s + c.count, 0)).toBeLessThanOrEqual(1);
  });

  it("builds around the strongest core and says so", () => {
    expect(deck.coreLines[0].topAttacker.name).toBe("Mega Slowbro ex");
    expect(deck.strategy).toContain("Mega Slowbro ex");
    expect(deck.strategy.length).toBeGreaterThan(40);
  });

  it("reports the main attackers' type weakness", () => {
    expect(deck.weaknesses.join(" ")).toContain("Darkness");
  });

  it("never uses more copies than owned", () => {
    const ownedByName = new Map(fixtureCollection().map((o) => [o.card.name, o.count]));
    for (const c of deck.cards) {
      expect(c.count).toBeLessThanOrEqual(ownedByName.get(c.card.name) ?? 0);
    }
  });
});

describe("buildDeck — 40 cards", () => {
  const deck = buildDeck(fixtureCollection(), { ...OPTS, deckSize: 40 })!;

  it("hits exactly 40 with scaled proportions", () => {
    expect(deck.total).toBe(40);
    expect(basicPokemonCount(deck)).toBeGreaterThanOrEqual(6);
    expect(energyCount(deck)).toBeGreaterThanOrEqual(8);
    expect(energyCount(deck)).toBeLessThanOrEqual(10);
    expect(deck.counts.draw).toBeGreaterThanOrEqual(4);
    expect(deck.counts.draw).toBeLessThanOrEqual(7);
  });
});

describe("buildDeck — copy limits against a deep pool", () => {
  // Owning MORE than 4 copies must not leak past the per-name cap, and owning
  // several ACE SPECs must not leak past the 1-per-deck cap.
  // Thin on non-ACE leftovers so the fill order genuinely reaches Prime Catcher.
  const deepPool: OwnedCard[] = [
    own(slowpoke, 4),
    own(slowbro, 2),
    own(megaSlowbroEx, 2),
    own(spritzee, 4),
    own(aromatisse, 3),
    own(research, 9),
    own(cheerfulTidings, 9),
    own(nestBall, 9),
    own(ultraBall, 9),
    own(switchCard, 9),
    own(potion, 9),
    own(vitalityBand, 2),
    own(primeCatcher, 3),
    own(psychicEnergy, 20),
  ];
  const deck = buildDeck(deepPool, OPTS)!;

  it("never exceeds 4 copies of a name even when more are owned", () => {
    for (const c of deck.cards) {
      if (!isBasicEnergy(c.card)) {
        expect(c.count, `${c.card.name} at ${c.count} copies`).toBeLessThanOrEqual(4);
      }
    }
  });

  it("runs exactly 1 ACE SPEC copy even when 3 are owned", () => {
    const aceSpecs = deck.cards.filter((c) => (c.card.subtypes ?? []).includes("ACE SPEC"));
    // Exactly 1: proves the fill order actually reached the ACE SPEC AND the cap held.
    expect(aceSpecs.reduce((s, c) => s + c.count, 0)).toBe(1);
  });

  it("still hits the exact deck size", () => {
    expect(deck.total).toBe(60);
  });
});

describe("buildDeck — options", () => {
  it("builds around must_include cards", () => {
    const deck = buildDeck(fixtureCollection(), { ...OPTS, mustInclude: ["Aromatisse"] })!;
    const names = deck.coreLines.flatMap((l) => l.stages.flat()).map((o) => o.card.name);
    expect(names).toContain("Aromatisse");
    expect(deck.cards.some((c) => c.card.name === "Aromatisse")).toBe(true);
  });

  it("forces an off-type, lower-scored must_include line into the core", () => {
    // The Lucario line shares no type with the Psychic core and has no ability —
    // the secondary-line selector would never pick it on its own.
    const pool = [...fixtureCollection(), own(riolu, 2), own(lucario, 2), own(fightingEnergy, 6)];
    const deck = buildDeck(pool, { ...OPTS, mustInclude: ["Lucario"] })!;
    const names = deck.coreLines.flatMap((l) => l.stages.flat()).map((o) => o.card.name);
    expect(names).toContain("Lucario");
    expect(deck.cards.some((c) => c.card.name === "Lucario")).toBe(true);
  });

  it("warns when a must_include card is not in the usable collection", () => {
    const deck = buildDeck(fixtureCollection(), { ...OPTS, mustInclude: ["Lucario"] })!;
    expect(deck.warnings.some((w) => w.toLowerCase().includes("lucario"))).toBe(true);
  });

  it("counts matching special energies toward the energy line", () => {
    const pool = fixtureCollection()
      .map((o) => (o.card.name === "Basic Psychic Energy" ? own(psychicEnergy, 10) : o))
      .concat([own(sparklingPsychicEnergy, 4)]);
    const deck = buildDeck(pool, OPTS)!;
    expect(deck.cards.some((c) => c.card.name === "Sparkling Psychic Energy")).toBe(true);
    expect(energyCount(deck)).toBeGreaterThanOrEqual(12);
  });

  it("produces decks that pass the shared check_deck rules", () => {
    const deck = buildDeck(fixtureCollection(), OPTS)!;
    const resolutions = deck.cards.map((c) => ({
      entry: { count: c.count, name: c.card.name, line: 0, raw: "" },
      card: c.card,
      notes: [],
    }));
    expect(deckProblems(resolutions, deck.total, { deckSize: 60, marks: MARKS })).toEqual([]);
  });

  it("treats a Pokémon with no subtypes and no evolvesFrom as a basic (live data gap)", () => {
    // Real example: Mankey me5-42 ships with an empty subtypes array.
    const bare = { ...slowpoke, id: "bare-1", subtypes: undefined };
    const deck = buildDeck([own(bare, 4), own(psychicEnergy, 10), own(research, 2)], OPTS)!;
    expect(deck.counts.basics).toBe(4);
  });

  it("returns a best-effort deck with warnings when the pool is too small", () => {
    const tiny = [own(slowpoke, 4), own(psychicEnergy, 10), own(research, 2)];
    const deck = buildDeck(tiny, OPTS);
    expect(deck).not.toBeNull();
    expect(deck!.total).toBeLessThan(60);
    expect(deck!.warnings.length).toBeGreaterThan(0);
  });

  it("excludes rotated cards in standard but keeps them in unrestricted", () => {
    const oldSlowpoke = { ...slowpoke, id: "old-1", regulationMark: "F" };
    const pool = [own(oldSlowpoke, 4), own(psychicEnergy, 10)];
    const std = buildDeck(pool, OPTS);
    const unrestricted = buildDeck(pool, { ...OPTS, format: "unrestricted" });
    expect(std?.cards.some((c) => c.card.id === "old-1") ?? false).toBe(false);
    expect(unrestricted!.cards.some((c) => c.card.id === "old-1")).toBe(true);
  });
});

describe("buildDecksFromCollection — two decks from one pool", () => {
  const pool: OwnedCard[] = [
    // psychic core
    own(slowpoke, 4),
    own(slowbro, 3),
    own(megaSlowbroEx, 2),
    own(spritzee, 4),
    own(aromatisse, 3),
    // fighting core, psychic-weak
    own(riolu, 4),
    own(lucario, 3),
    // shared trainers — enough copies for both decks to hit their minimums
    own(research, 8),
    own(cheerfulTidings, 8),
    own(nestBall, 8),
    own(ultraBall, 8),
    own(switchCard, 8),
    own(potion, 8),
    own(vitalityBand, 8),
    own(rareCandy, 8),
    own(fullHeal, 8),
    own(psychicEnergy, 20),
    own(fightingEnergy, 20),
  ];

  const result = buildDecksFromCollection(pool, { ...OPTS, deckCount: 2 });

  it("builds two full decks without overdrawing the shared pool", () => {
    expect(result.decks).toHaveLength(2);
    const used = new Map<string, number>();
    for (const deck of result.decks) {
      expect(deck.total).toBe(60);
      for (const c of deck.cards) {
        used.set(c.card.name, (used.get(c.card.name) ?? 0) + c.count);
      }
    }
    const ownedByName = new Map(pool.map((o) => [o.card.name, o.count]));
    for (const [name, count] of used) {
      expect(count, `${name} used ${count}`).toBeLessThanOrEqual(ownedByName.get(name) ?? 0);
    }
  });

  it("reports a counter-score with all five components and a verdict", () => {
    expect(result.counter).toBeDefined();
    expect(result.counter!.components).toHaveLength(5);
    expect(result.counter!.verdict.length).toBeGreaterThan(0);
    expect(result.attempts).toBeGreaterThanOrEqual(1);
    expect(result.attempts).toBeLessThanOrEqual(5);
  });

  it("iterates away from an antagonistic pairing when a neutral core exists", () => {
    // Three cores: psychic (best), psychic-weak fighting (second), neutral
    // lightning (third). Attempt 1 pairs psychic vs fighting and trips the
    // weakness component; banning Lucario must steer deck 2 onto the
    // Tynamo/Eelektrik line and land under the "balanced" threshold.
    const richPool: OwnedCard[] = [
      own(slowpoke, 4),
      own(slowbro, 3),
      own(megaSlowbroEx, 2),
      own(spritzee, 4),
      own(aromatisse, 3),
      own(riolu, 4),
      own(lucario, 3),
      own(tynamo, 4),
      own(eelektrik, 3),
      own(research, 8),
      own(cheerfulTidings, 8),
      own(nestBall, 8),
      own(ultraBall, 8),
      own(switchCard, 8),
      own(potion, 8),
      own(vitalityBand, 8),
      own(rareCandy, 8),
      own(fullHeal, 8),
      own(psychicEnergy, 20),
      own(fightingEnergy, 15),
      own(lightningEnergy, 20),
    ];
    const balanced = buildDecksFromCollection(richPool, { ...OPTS, deckCount: 2 });
    expect(balanced.decks).toHaveLength(2);
    expect(balanced.attempts).toBeGreaterThanOrEqual(2);
    expect(balanced.counter!.total).toBeLessThan(3);
    const deck2Names = balanced.decks[1].cards.map((c) => c.card.name);
    expect(deck2Names).toContain("Eelektrik");
    expect(deck2Names).not.toContain("Lucario");
  });

  it("either separates the antagonistic cores or reports the weakness matchup honestly", () => {
    const [a, b] = result.decks;
    const typesOf = (d: BuiltDeck) => new Set(d.attackers.flatMap((c) => c.types ?? []));
    const weakHit =
      [...typesOf(a)].some((t) => b.attackers.some((c) => (c.weaknesses ?? []).some((w) => w.type === t))) ||
      [...typesOf(b)].some((t) => a.attackers.some((c) => (c.weaknesses ?? []).some((w) => w.type === t)));
    const weaknessComponent = result.counter!.components.find((c) => c.id === 1)!;
    if (weakHit) {
      expect(weaknessComponent.triggered).toBe(true);
      expect(weaknessComponent.score).toBeGreaterThan(0);
    } else {
      expect(weaknessComponent.score).toBe(0);
    }
  });
});
