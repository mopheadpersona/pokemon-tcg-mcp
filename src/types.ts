export interface Ability {
  name: string;
  text: string;
  type?: string;
}

export interface Attack {
  name: string;
  cost?: string[];
  convertedEnergyCost?: number;
  damage?: string;
  text?: string;
}

export interface SetInfo {
  id: string;
  name: string;
  series?: string;
  ptcgoCode?: string;
  releaseDate?: string;
  total?: number;
  printedTotal?: number;
}

export interface TcgPlayerPriceBlock {
  low?: number;
  mid?: number;
  high?: number;
  market?: number;
  directLow?: number;
}

export interface Card {
  id: string;
  name: string;
  supertype: string;
  subtypes?: string[];
  hp?: string;
  types?: string[];
  evolvesFrom?: string;
  abilities?: Ability[];
  attacks?: Attack[];
  weaknesses?: { type: string; value: string }[];
  resistances?: { type: string; value: string }[];
  retreatCost?: string[];
  rules?: string[];
  regulationMark?: string;
  number: string;
  rarity?: string;
  set: SetInfo;
  legalities?: Record<string, string>;
  images?: { small?: string; large?: string };
  tcgplayer?: {
    url?: string;
    updatedAt?: string;
    prices?: Record<string, TcgPlayerPriceBlock>;
  };
  cardmarket?: {
    url?: string;
    updatedAt?: string;
    prices?: {
      trendPrice?: number;
      averageSellPrice?: number;
      lowPrice?: number;
      avg1?: number;
      avg7?: number;
      avg30?: number;
      [key: string]: number | undefined;
    };
  };
}
