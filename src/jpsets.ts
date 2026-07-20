/**
 * Japanese-card support tables for the kitchen-table workflow. Both tables are
 * plain exported constants — extend them by adding entries, nothing else to
 * touch. When a JP set code is missing here, resolve_scanned says so
 * explicitly and falls back to a name search; it never guesses.
 */

/**
 * JP set code → TCG Live codes of the matching English set(s). Mega-era codes
 * follow the JP "mN" numbering, which lines up with the English me1…me5
 * releases. JP collector numbers do NOT match English numbering, so mapped
 * lines are resolved by card name within the set, with the JP number kept as
 * a hint only.
 */
export const JP_SET_CODES: Record<string, string[]> = {
  M1: ["MEG"], // Mega Evolution (me1)
  M2: ["PFL"], // me2
  M3: ["POR"], // Perfect Order (me3)
  M4: ["CRI"], // Chaos Rising (me4)
  M5: ["PBL"], // Pitch Black (me5)
};

/** Token that looks like a JP set code (Mega-era mN, promo mN-P …) even when unmapped. */
export const JP_SET_CODE_SHAPE = /^m\d{1,2}(?:-?p)?$/i;

/**
 * JP card name → English card name, for the most common cases when the client
 * transcribes the printed Japanese name instead of translating it. The Claude
 * client is expected to translate names it knows; this map is the server-side
 * safety net, not a dictionary.
 */
export const JP_CARD_NAMES: Record<string, string> = {
  // Slowpoke line (the kitchen-table regulars)
  ヤドン: "Slowpoke",
  ヤドラン: "Slowbro",
  ヤドキング: "Slowking",
  // Kanto classics
  フシギダネ: "Bulbasaur",
  フシギソウ: "Ivysaur",
  フシギバナ: "Venusaur",
  ヒトカゲ: "Charmander",
  リザード: "Charmeleon",
  リザードン: "Charizard",
  ゼニガメ: "Squirtle",
  カメール: "Wartortle",
  カメックス: "Blastoise",
  ピカチュウ: "Pikachu",
  ライチュウ: "Raichu",
  イーブイ: "Eevee",
  コイキング: "Magikarp",
  ギャラドス: "Gyarados",
  ゲンガー: "Gengar",
  カビゴン: "Snorlax",
  ラプラス: "Lapras",
  ミュウ: "Mew",
  ミュウツー: "Mewtwo",
  // Later-generation staples
  ルギア: "Lugia",
  ホウオウ: "Ho-Oh",
  レックウザ: "Rayquaza",
  ラルトス: "Ralts",
  キルリア: "Kirlia",
  サーナイト: "Gardevoir",
  エルレイド: "Gallade",
  リオル: "Riolu",
  ルカリオ: "Lucario",
  ガブリアス: "Garchomp",
  ジガルデ: "Zygarde",
  シキジカ: "Deerling",
  メタモン: "Ditto",
};

/** Does the text contain Japanese characters (kana or kanji)? */
export function hasJapaneseText(text: string): boolean {
  return /[぀-ヿㇰ-ㇿ一-鿿ｦ-ﾟ]/.test(text);
}

/**
 * Translate a scanned Japanese card name to English via JP_CARD_NAMES,
 * handling the メガ prefix and the ex suffix ("メガヤドランex" → "Mega Slowbro
 * ex"). Returns undefined when the base name is not in the table.
 */
export function translateJpName(raw: string): string | undefined {
  let name = raw.trim();
  const direct = JP_CARD_NAMES[name];
  if (direct) return direct;

  let suffix = "";
  const exMatch = /\s*ex$/i.exec(name);
  if (exMatch) {
    suffix = " ex";
    name = name.slice(0, exMatch.index).trim();
  }
  let prefix = "";
  if (name.startsWith("メガ")) {
    prefix = "Mega ";
    name = name.slice("メガ".length).trim();
  }
  const base = JP_CARD_NAMES[name];
  if (!base) return undefined;
  return `${prefix}${base}${suffix}`;
}

/** TCG Live codes for a JP set code, or undefined when the table has no entry. */
export function jpSetCodeCandidates(code: string): string[] | undefined {
  return JP_SET_CODES[code.toUpperCase()];
}
