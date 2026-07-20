import { describe, expect, it } from "vitest";

import {
  curesSpecialConditions,
  discardsOpponentEnergy,
  hasBenchDamage,
  hasEnergyAcceleration,
  inflictsSpecialConditions,
  isBenchSitter,
  isDrawSupporter,
  isHealingCard,
  isMultiPrize,
  isPokemonTool,
  isSearchItem,
  isSwitchCard,
  maxAttackDamage,
  parseDamage,
} from "../src/effects.js";
import {
  atk,
  benchSitter,
  cheerfulTidings,
  energyDenier,
  fullHeal,
  megaSlowbroEx,
  nestBall,
  pokemon,
  potion,
  research,
  slowbro,
  slowpoke,
  sniper,
  switchCard,
  toxicroak,
  ultraBall,
  vitalityBand,
} from "./fixtures.js";

describe("parseDamage / maxAttackDamage", () => {
  it("reads plain and suffixed damage values", () => {
    expect(parseDamage("110")).toBe(110);
    expect(parseDamage("70+")).toBe(70);
    expect(parseDamage("50×")).toBe(50);
    expect(parseDamage(undefined)).toBe(0);
    expect(parseDamage("")).toBe(0);
  });

  it("takes the highest attack on the card", () => {
    expect(maxAttackDamage(slowbro)).toBe(110);
    expect(maxAttackDamage(benchSitter)).toBe(0);
  });
});

describe("trainer classification", () => {
  it("detects draw supporters but not draw-less trainers", () => {
    expect(isDrawSupporter(research)).toBe(true);
    expect(isDrawSupporter(cheerfulTidings)).toBe(true);
    expect(isDrawSupporter(nestBall)).toBe(false);
    expect(isDrawSupporter(switchCard)).toBe(false);
  });

  it("detects deck-search items", () => {
    expect(isSearchItem(nestBall)).toBe(true);
    expect(isSearchItem(ultraBall)).toBe(true);
    expect(isSearchItem(potion)).toBe(false);
    // Research shuffles nothing and searches nothing — draw only.
    expect(isSearchItem(research)).toBe(false);
  });

  it("detects switch effects, healing and tools", () => {
    expect(isSwitchCard(switchCard)).toBe(true);
    expect(isSwitchCard(potion)).toBe(false);
    expect(isHealingCard(potion)).toBe(true);
    expect(isHealingCard(switchCard)).toBe(false);
    expect(isPokemonTool(vitalityBand)).toBe(true);
    expect(isPokemonTool(potion)).toBe(false);
  });
});

describe("special conditions", () => {
  it("detects inflicting attacks", () => {
    expect(inflictsSpecialConditions(toxicroak)).toBe(true);
    expect(inflictsSpecialConditions(slowbro)).toBe(false);
  });

  it("detects cures without confusing them with inflictions", () => {
    expect(curesSpecialConditions(fullHeal)).toBe(true);
    expect(curesSpecialConditions(toxicroak)).toBe(false);
    expect(curesSpecialConditions(potion)).toBe(false);
  });
});

describe("energy denial / bench damage / bench sitters", () => {
  it("detects opponent-energy discard but not self-discard costs", () => {
    expect(discardsOpponentEnergy(energyDenier)).toBe(true);
    // Ultra Ball discards from your own hand; Research discards your hand.
    expect(discardsOpponentEnergy(ultraBall)).toBe(false);
    expect(discardsOpponentEnergy(research)).toBe(false);
  });

  it("detects bench damage", () => {
    expect(hasBenchDamage(sniper)).toBe(true);
    expect(hasBenchDamage(slowbro)).toBe(false);
  });

  it("detects ability Pokémon with no meaningful attacks as bench sitters", () => {
    expect(isBenchSitter(benchSitter)).toBe(true);
    expect(isBenchSitter(slowbro)).toBe(false);
    expect(isBenchSitter(slowpoke)).toBe(false);
  });
});

describe("acceleration and prize liability", () => {
  it("detects built-in energy acceleration", () => {
    const accel = pokemon({
      name: "Chargey",
      hp: 90,
      types: ["Lightning"],
      attacks: [
        atk("Recharge", ["Lightning"], "20", "Attach a Lightning Energy from your discard pile to 1 of your Benched Pokémon."),
      ],
    });
    expect(hasEnergyAcceleration(accel)).toBe(true);
    expect(hasEnergyAcceleration(slowbro)).toBe(false);
  });

  it("detects multi-prize Pokémon from rules text", () => {
    expect(isMultiPrize(megaSlowbroEx)).toBe(true);
    expect(isMultiPrize(slowbro)).toBe(false);
  });
});
