import { describe, expect, it } from "vitest";

import { countByName, looksLikeBasicEnergy, normalizeName, parseDecklist } from "../src/deck.js";

const LIVE_EXPORT = `Pokémon: 8
4 Slowpoke PBL 29
4 Psyduck ASC 39

Trainer: 39
4 Jacinthe POR 75
1 Iono PAL 185
4 Buddy-Buddy Poffin TWM 144

Energy: 13
13 Basic {P} Energy SVE 13

Total Cards: 60`;

describe("parseDecklist", () => {
  it("parses a TCG Live export with sections and totals", () => {
    const deck = parseDecklist(LIVE_EXPORT);
    expect(deck.entries).toHaveLength(6);
    expect(deck.declaredTotal).toBe(60);
    expect(deck.totalCards).toBe(4 + 4 + 4 + 1 + 4 + 13);
    expect(deck.warnings.some((w) => w.includes("Total Cards"))).toBe(true); // 30 ≠ 60 in this fixture
  });

  it("extracts count, name, set code and number", () => {
    const [slowpoke] = parseDecklist("4 Slowpoke PBL 29").entries;
    expect(slowpoke).toMatchObject({ count: 4, name: "Slowpoke", setCode: "PBL", number: "29" });
  });

  it("expands {P}-style basic energy shorthand", () => {
    const [energy] = parseDecklist("13 Basic {P} Energy SVE 13").entries;
    expect(energy.name).toBe("Basic Psychic Energy");
    expect(energy.setCode).toBe("SVE");
  });

  it("handles PTCGO's pseudo set code 'Energy' by falling back to name resolution", () => {
    const [energy] = parseDecklist("6 Psychic Energy Energy 5").entries;
    expect(energy).toMatchObject({ name: "Psychic Energy", setCode: undefined, number: undefined });
  });

  it("handles subset numbering like GG44 / TG12 and hyphenated codes like PR-SV", () => {
    const entries = parseDecklist("1 Zamazenta CRZ GG44\n1 Mew PR-SV 232").entries;
    expect(entries[0]).toMatchObject({ setCode: "CRZ", number: "GG44" });
    expect(entries[1]).toMatchObject({ setCode: "PR-SV", number: "232" });
  });

  it("strips PTCGO foil markers (PH)", () => {
    const [card] = parseDecklist("4 Rare Candy PGO 69 PH").entries;
    expect(card).toMatchObject({ name: "Rare Candy", setCode: "PGO", number: "69" });
  });

  it("supports '4x' style counts and leading bullets", () => {
    const entries = parseDecklist("4x Rare Candy SVI 191\n* 2 Nest Ball SVI 181").entries;
    expect(entries[0]).toMatchObject({ count: 4, name: "Rare Candy" });
    expect(entries[1]).toMatchObject({ count: 2, name: "Nest Ball" });
  });

  it("keeps digit-suffixed names like Porygon2 intact", () => {
    const [card] = parseDecklist("2 Porygon2 SCR 156").entries;
    expect(card).toMatchObject({ name: "Porygon2", setCode: "SCR", number: "156" });
  });

  it("treats name-only lines as name lookups", () => {
    const [card] = parseDecklist("4 Rare Candy").entries;
    expect(card).toMatchObject({ count: 4, name: "Rare Candy", setCode: undefined, number: undefined });
  });

  it("peels a bare trailing number with a warning when no set code precedes it", () => {
    const deck = parseDecklist("2 Nest Ball 181");
    expect(deck.entries[0]).toMatchObject({ name: "Nest Ball", number: "181", setCode: undefined });
    expect(deck.warnings.some((w) => w.includes("no set code"))).toBe(true);
  });

  it("warns about unparseable lines instead of failing", () => {
    const deck = parseDecklist("4 Slowpoke PBL 29\nthis is not a card");
    expect(deck.entries).toHaveLength(1);
    expect(deck.warnings.some((w) => w.includes("not a card"))).toBe(true);
  });

  it("ignores section headers including counts", () => {
    const deck = parseDecklist("Pokémon: 12\nTrainer: 33\nEnergy: 15\n4 Slowpoke PBL 29");
    expect(deck.entries).toHaveLength(1);
    expect(deck.warnings).toHaveLength(0);
  });
});

describe("countByName", () => {
  it("aggregates copies of the same name across printings", () => {
    const deck = parseDecklist("4 Jacinthe POR 75\n1 Jacinthe POR 110\n2 Iono PAL 185");
    const counts = countByName(deck.entries);
    expect(counts.get("jacinthe")).toBe(5);
    expect(counts.get("iono")).toBe(2);
  });
});

describe("normalizeName / looksLikeBasicEnergy", () => {
  it("normalizes whitespace and case", () => {
    expect(normalizeName("  Boss's   Orders ")).toBe("boss's orders");
  });

  it("recognizes basic energy names with and without the Basic prefix", () => {
    expect(looksLikeBasicEnergy("Basic Psychic Energy")).toBe(true);
    expect(looksLikeBasicEnergy("Water Energy")).toBe(true);
    expect(looksLikeBasicEnergy("Jet Energy")).toBe(false);
    expect(looksLikeBasicEnergy("Double Turbo Energy")).toBe(false);
  });
});
