/**
 * Hand-crafted Card fixtures for the deck builder / counter-score tests.
 * Stats are invented but shaped like real cards (reg J, one fixture set).
 */
import type { Ability, Attack, Card } from "../src/types.js";
import type { OwnedCard } from "../src/deckbuilder.js";

const FIXTURE_SET = { id: "fix1", name: "Fixture Set", ptcgoCode: "FIX", releaseDate: "2026/01/01", total: 200 };
let seq = 0;

export function atk(name: string, cost: string[], damage?: string, text?: string): Attack {
  return { name, cost, convertedEnergyCost: cost.length, damage, text };
}

interface PokemonSpec {
  name: string;
  hp: number;
  types: string[];
  subtypes?: string[];
  evolvesFrom?: string;
  attacks?: Attack[];
  abilities?: Ability[];
  weaknesses?: { type: string; value: string }[];
  rules?: string[];
}

export function pokemon(spec: PokemonSpec): Card {
  seq += 1;
  return {
    id: `fix1-${seq}`,
    name: spec.name,
    supertype: "Pokémon",
    subtypes: spec.subtypes ?? ["Basic"],
    hp: String(spec.hp),
    types: spec.types,
    evolvesFrom: spec.evolvesFrom,
    attacks: spec.attacks,
    abilities: spec.abilities,
    weaknesses: spec.weaknesses,
    retreatCost: ["Colorless"],
    rules: spec.rules,
    regulationMark: "J",
    number: String(seq),
    set: FIXTURE_SET,
  };
}

export function trainer(name: string, subtype: string, text: string, extraSubtypes: string[] = []): Card {
  seq += 1;
  return {
    id: `fix1-${seq}`,
    name,
    supertype: "Trainer",
    subtypes: [subtype, ...extraSubtypes],
    rules: [text],
    regulationMark: "J",
    number: String(seq),
    set: FIXTURE_SET,
  };
}

export function energy(name: string, subtypes: string[] = ["Basic"], text?: string): Card {
  seq += 1;
  return {
    id: `fix1-${seq}`,
    name,
    supertype: "Energy",
    subtypes,
    rules: text ? [text] : undefined,
    // Basic energies genuinely carry no regulation mark.
    regulationMark: subtypes.includes("Basic") ? undefined : "J",
    number: String(seq),
    set: FIXTURE_SET,
  };
}

export function own(card: Card, count: number): OwnedCard {
  return { card, count };
}

// ---------------------------------------------------------------- Pokémon
export const slowpoke = pokemon({
  name: "Slowpoke",
  hp: 70,
  types: ["Psychic"],
  attacks: [atk("Ram", ["Psychic", "Colorless"], "30")],
  weaknesses: [{ type: "Darkness", value: "×2" }],
});

export const slowbro = pokemon({
  name: "Slowbro",
  hp: 130,
  types: ["Psychic"],
  subtypes: ["Stage 1"],
  evolvesFrom: "Slowpoke",
  attacks: [atk("Yawning Blast", ["Psychic", "Psychic", "Colorless"], "110")],
  weaknesses: [{ type: "Darkness", value: "×2" }],
});

export const megaSlowbroEx = pokemon({
  name: "Mega Slowbro ex",
  hp: 340,
  types: ["Psychic"],
  subtypes: ["Stage 2", "Mega", "ex"],
  evolvesFrom: "Slowbro",
  attacks: [atk("Kinetic Cannon", ["Psychic", "Psychic", "Colorless"], "200")],
  weaknesses: [{ type: "Darkness", value: "×2" }],
  rules: ["Mega Evolution ex rule: When your Mega Evolution Pokémon ex is Knocked Out, your opponent takes 3 Prize cards."],
});

export const spritzee = pokemon({
  name: "Spritzee",
  hp: 60,
  types: ["Psychic"],
  attacks: [atk("Sweet Scent", ["Colorless"], "10")],
  weaknesses: [{ type: "Metal", value: "×2" }],
});

export const aromatisse = pokemon({
  name: "Aromatisse",
  hp: 110,
  types: ["Psychic"],
  subtypes: ["Stage 1"],
  evolvesFrom: "Spritzee",
  abilities: [
    {
      name: "Fairy Transfer",
      type: "Ability",
      text: "As often as you like during your turn, you may move a Psychic Energy from 1 of your Pokémon to another of your Pokémon.",
    },
  ],
  attacks: [atk("Slap", ["Psychic", "Colorless"], "40")],
  weaknesses: [{ type: "Metal", value: "×2" }],
});

export const riolu = pokemon({
  name: "Riolu",
  hp: 70,
  types: ["Fighting"],
  attacks: [atk("Jab", ["Fighting"], "20")],
  weaknesses: [{ type: "Psychic", value: "×2" }],
});

export const lucario = pokemon({
  name: "Lucario",
  hp: 130,
  types: ["Fighting"],
  subtypes: ["Stage 1"],
  evolvesFrom: "Riolu",
  attacks: [atk("Aura Sphere", ["Fighting", "Fighting"], "120")],
  weaknesses: [{ type: "Psychic", value: "×2" }],
});

export const toxicroak = pokemon({
  name: "Toxicroak",
  hp: 120,
  types: ["Darkness"],
  subtypes: ["Stage 1"],
  evolvesFrom: "Croagunk",
  attacks: [
    atk("Poison Jab", ["Darkness", "Colorless"], "60", "Your opponent's Active Pokémon is now Poisoned."),
  ],
  weaknesses: [{ type: "Fighting", value: "×2" }],
});

export const hypno = pokemon({
  name: "Hypno",
  hp: 110,
  types: ["Psychic"],
  subtypes: ["Stage 1"],
  evolvesFrom: "Drowzee",
  attacks: [
    atk("Sleep Pendulum", ["Psychic"], "10", "Your opponent's Active Pokémon is now Asleep."),
    atk("Psybeam", ["Psychic", "Colorless", "Colorless"], "100"),
  ],
  weaknesses: [{ type: "Darkness", value: "×2" }],
});

export const energyDenier = pokemon({
  name: "Crushgrip",
  hp: 120,
  types: ["Fighting"],
  attacks: [
    atk("Energy Crush", ["Fighting", "Colorless"], "50", "Discard an Energy from your opponent's Active Pokémon."),
  ],
  weaknesses: [{ type: "Psychic", value: "×2" }],
});

export const heavyTank = pokemon({
  name: "Slowtank",
  hp: 180,
  types: ["Metal"],
  attacks: [atk("Heavy Impact", ["Metal", "Metal", "Colorless", "Colorless"], "180")],
  weaknesses: [{ type: "Fire", value: "×2" }],
});

export const sniper = pokemon({
  name: "Longshot",
  hp: 110,
  types: ["Lightning"],
  attacks: [
    atk("Snipe Shot", ["Lightning"], "30", "This attack does 30 damage to 1 of your opponent's Benched Pokémon. (Don't apply Weakness and Resistance for Benched Pokémon.)"),
    atk("Thunder", ["Lightning", "Lightning", "Colorless"], "120"),
  ],
  weaknesses: [{ type: "Fighting", value: "×2" }],
});

export const benchSitter = pokemon({
  name: "Cheerlead",
  hp: 70,
  types: ["Psychic"],
  abilities: [
    {
      name: "Flower Cheer",
      type: "Ability",
      text: "Once during your turn, if this Pokémon is on your Bench, you may draw a card.",
    },
  ],
  weaknesses: [{ type: "Darkness", value: "×2" }],
});

export const fastAttacker = pokemon({
  name: "Quickstrike",
  hp: 120,
  types: ["Lightning"],
  attacks: [atk("Lightning Rush", ["Lightning", "Colorless"], "120")],
  weaknesses: [{ type: "Fighting", value: "×2" }],
});

// A neutral third core for counter-balance iteration tests: weak stage-1 line
// whose basic is a non-attacker, so it never becomes a "main attacker" pad.
export const tynamo = pokemon({
  name: "Tynamo",
  hp: 60,
  types: ["Lightning"],
  attacks: [atk("Tiny Charge", ["Lightning"], "10")],
  weaknesses: [{ type: "Fighting", value: "×2" }],
});

export const eelektrik = pokemon({
  name: "Eelektrik",
  hp: 90,
  types: ["Lightning"],
  subtypes: ["Stage 1"],
  evolvesFrom: "Tynamo",
  attacks: [atk("Charged Fangs", ["Lightning", "Colorless"], "120")],
  weaknesses: [{ type: "Fighting", value: "×2" }],
});

// ---------------------------------------------------------------- Trainers
export const research = trainer("Professor's Research", "Supporter", "Discard your hand and draw 7 cards.");
export const cheerfulTidings = trainer("Cheerful Tidings", "Supporter", "Draw cards until you have 6 cards in your hand.");
export const nestBall = trainer("Nest Ball", "Item", "Search your deck for a Basic Pokémon and put it onto your Bench. Then, shuffle your deck.");
export const ultraBall = trainer("Ultra Ball", "Item", "You can use this card only if you discard 2 other cards from your hand. Search your deck for a Pokémon, reveal it, and put it into your hand. Then, shuffle your deck.");
export const switchCard = trainer("Switch", "Item", "Switch your Active Pokémon with 1 of your Benched Pokémon.");
export const potion = trainer("Potion", "Item", "Heal 30 damage from 1 of your Pokémon.");
export const fullHeal = trainer("Full Heal", "Item", "Remove all Special Conditions from your Active Pokémon.");
export const vitalityBand = trainer("Vitality Band", "Pokémon Tool", "The attacks of the Pokémon this card is attached to do 10 more damage to your opponent's Active Pokémon.");
export const primeCatcher = trainer("Prime Catcher", "Item", "Switch in 1 of your opponent's Benched Pokémon to the Active Spot. If you do, switch your Active Pokémon with 1 of your Benched Pokémon.", ["ACE SPEC"]);
export const rareCandy = trainer("Rare Candy", "Item", "Choose 1 of your Basic Pokémon in play. If you have a Stage 2 card in your hand that evolves from that Pokémon, put that card onto the Basic Pokémon to evolve it, skipping the Stage 1.");

// ---------------------------------------------------------------- Energy
export const psychicEnergy = energy("Basic Psychic Energy");
export const sparklingPsychicEnergy = energy(
  "Sparkling Psychic Energy",
  ["Special"],
  "As long as this card is attached to a Pokémon, it provides Psychic Energy.",
);
export const fightingEnergy = energy("Basic Fighting Energy");
export const metalEnergy = energy("Basic Metal Energy");
export const lightningEnergy = energy("Basic Lightning Energy");
export const darknessEnergy = energy("Basic Darkness Energy");

/** The acceptance-check-1-shaped collection: Slowbro core + Aromatisse + trainers + energy. */
export function fixtureCollection(): OwnedCard[] {
  return [
    own(slowpoke, 4),
    own(slowbro, 2),
    own(megaSlowbroEx, 2),
    own(spritzee, 4),
    own(aromatisse, 3),
    own(research, 4),
    own(cheerfulTidings, 4),
    own(nestBall, 4),
    own(ultraBall, 4),
    own(switchCard, 4),
    own(potion, 4),
    own(rareCandy, 4),
    own(vitalityBand, 2),
    own(primeCatcher, 1),
    own(psychicEnergy, 20),
  ];
}
