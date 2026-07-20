import { describe, expect, it } from "vitest";

import { counterScore, mainAttackers, type DeckForScore } from "../src/counterscore.js";
import {
  benchSitter,
  cheerfulTidings,
  darknessEnergy,
  energyDenier,
  fastAttacker,
  fightingEnergy,
  fullHeal,
  heavyTank,
  hypno,
  lightningEnergy,
  lucario,
  megaSlowbroEx,
  metalEnergy,
  nestBall,
  own,
  potion,
  psychicEnergy,
  research,
  riolu,
  slowbro,
  slowpoke,
  sniper,
  switchCard,
  toxicroak,
} from "./fixtures.js";

function deck(label: string, cards: ReturnType<typeof own>[]): DeckForScore {
  return { label, cards };
}

/** Standard trainer/energy shell so decks look like decks, with no counter signals. */
function shell(energyCard: ReturnType<typeof own>["card"]): ReturnType<typeof own>[] {
  return [own(research, 4), own(nestBall, 4), own(switchCard, 2), own(energyCard, 12)];
}

const psychicDeck = deck("Psychic", [
  own(slowpoke, 4),
  own(slowbro, 3),
  own(megaSlowbroEx, 2),
  ...shell(psychicEnergy),
]);

const fightingDeck = deck("Fighting", [own(riolu, 4), own(lucario, 3), ...shell(fightingEnergy)]);

describe("mainAttackers", () => {
  it("keeps real attackers and drops support sitters", () => {
    const attackers = mainAttackers([own(slowbro, 3), own(benchSitter, 2), own(research, 4)]);
    expect(attackers.map((a) => a.card.name)).toEqual(["Slowbro"]);
  });
});

describe("component 1 — weakness exploitation", () => {
  it("flags a psychic-weak fighting deck against a psychic deck", () => {
    const result = counterScore(psychicDeck, fightingDeck);
    const c1 = result.components.find((c) => c.id === 1)!;
    expect(c1.triggered).toBe(true);
    expect(c1.score).toBe(10); // every fighting attacker is psychic-weak
    expect(c1.weight).toBe(3);
    expect(c1.explanation).toContain("Psychic");
    expect(result.total).toBeGreaterThanOrEqual(3);
  });

  it("is order-independent: the worse direction scores regardless of argument order", () => {
    // Same matchup, arguments swapped — the B→A direction must be evaluated too.
    const result = counterScore(fightingDeck, psychicDeck);
    const c1 = result.components.find((c) => c.id === 1)!;
    expect(c1.triggered).toBe(true);
    expect(c1.score).toBe(10);
    expect(c1.offenders.some((o) => o.deck === "Fighting")).toBe(true); // the weak side swaps
    expect(result.total).toBe(counterScore(psychicDeck, fightingDeck).total);
  });

  it("weights the fraction by copies, not by distinct names", () => {
    // 4 psychic-weak copies + 1 non-weak copy of main attackers → 10 × 4/5 = 8.
    const mixed = deck("Mixed", [own(lucario, 4), own(fastAttacker, 1), ...shell(fightingEnergy)]);
    const result = counterScore(psychicDeck, mixed);
    const c1 = result.components.find((c) => c.id === 1)!;
    expect(c1.score).toBe(8);
  });

  it("stays quiet when no attacker weakness lines up", () => {
    // Psychic deck (darkness-weak) vs psychic deck: no darkness attackers anywhere.
    const result = counterScore(psychicDeck, psychicDeck);
    expect(result.components.find((c) => c.id === 1)!.score).toBe(0);
  });
});

describe("component 2 — status execution vs no cure", () => {
  const statusDeck = deck("Status", [own(toxicroak, 4), own(hypno, 4), ...shell(darknessEnergy)]);

  it("flags a status deck against a deck with zero condition removal", () => {
    const result = counterScore(statusDeck, fightingDeck);
    const c2 = result.components.find((c) => c.id === 2)!;
    expect(c2.triggered).toBe(true);
    expect(c2.score).toBeGreaterThan(0);
    expect(c2.explanation.toLowerCase()).toContain("special condition");
  });

  it("triggers with the status deck in either argument position", () => {
    const result = counterScore(fightingDeck, statusDeck);
    const c2 = result.components.find((c) => c.id === 2)!;
    expect(c2.triggered).toBe(true);
    expect(c2.score).toBeGreaterThan(0);
  });

  it("stays quiet when the other deck runs a cure", () => {
    const cured = deck("Cured", [own(riolu, 4), own(lucario, 3), own(fullHeal, 2), ...shell(fightingEnergy)]);
    const result = counterScore(statusDeck, cured);
    expect(result.components.find((c) => c.id === 2)!.score).toBe(0);
  });
});

describe("component 3 — energy denial vs expensive attacks", () => {
  const denialDeck = deck("Denial", [own(energyDenier, 4), ...shell(fightingEnergy)]);

  it("flags denial against a deck averaging 3+ energy per attack", () => {
    const tankDeck = deck("Tank", [own(heavyTank, 4), ...shell(metalEnergy)]);
    const result = counterScore(denialDeck, tankDeck);
    const c3 = result.components.find((c) => c.id === 3)!;
    expect(c3.triggered).toBe(true);
    expect(c3.score).toBeGreaterThan(0);
  });

  it("stays quiet against cheap attackers", () => {
    const cheapDeck = deck("Cheap", [own(fastAttacker, 4), ...shell(lightningEnergy)]);
    const result = counterScore(denialDeck, cheapDeck);
    expect(result.components.find((c) => c.id === 3)!.score).toBe(0);
  });
});

describe("component 4 — snipe vs bench reliance", () => {
  const snipeDeck = deck("Snipe", [own(sniper, 4), ...shell(lightningEnergy)]);

  it("flags snipe against a deck leaning on bench sitters", () => {
    const benchDeck = deck("Bench", [own(slowbro, 3), own(benchSitter, 4), ...shell(psychicEnergy)]);
    const result = counterScore(snipeDeck, benchDeck);
    const c4 = result.components.find((c) => c.id === 4)!;
    expect(c4.triggered).toBe(true);
    expect(c4.score).toBeGreaterThan(0);
  });

  it("stays quiet when the other deck has no bench reliance", () => {
    const result = counterScore(snipeDeck, fightingDeck);
    expect(result.components.find((c) => c.id === 4)!.score).toBe(0);
  });
});

describe("component 5 — tempo mismatch", () => {
  it("scores the gap between a turn-2 and a turn-4 deck", () => {
    const fast = deck("Fast", [own(fastAttacker, 4), ...shell(lightningEnergy)]); // 100+ at 2 energy
    const slow = deck("Slow", [own(heavyTank, 4), ...shell(metalEnergy)]); // 100+ at 4 energy
    const result = counterScore(fast, slow);
    const c5 = result.components.find((c) => c.id === 5)!;
    expect(c5.weight).toBe(1);
    expect(c5.score).toBeGreaterThan(0);
  });
});

describe("verdicts", () => {
  it("calls a trigger-free pair balanced", () => {
    // Mirror match: same speed, no weakness overlap, no status/denial/snipe.
    const result = counterScore(psychicDeck, psychicDeck);
    expect(result.total).toBeLessThan(3);
    expect(result.verdict).toContain("balanced");
  });

  it("recommends a rebuild when multiple heavy components fire", () => {
    const statusSnipe = deck("StatusSnipe", [
      own(toxicroak, 4),
      own(hypno, 4),
      own(sniper, 4),
      ...shell(darknessEnergy),
    ]);
    const benchStall = deck("BenchStall", [
      own(riolu, 4),
      own(lucario, 4),
      own(benchSitter, 4),
      ...shell(fightingEnergy),
    ]);
    // Weakness (psychic Hypno vs psychic-weak Lucario) + status/no-cure + snipe/bench.
    const result = counterScore(statusSnipe, benchStall);
    expect(result.total).toBeGreaterThan(6);
    expect(result.verdict.toLowerCase()).toContain("rebuild");
  });
});
