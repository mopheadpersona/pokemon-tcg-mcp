import { standardBadge } from "./legality.js";
import type { Attack, Card } from "./types.js";

export function marksNote(marks: string[]): string {
  return `_Standard legality computed from regulation marks (currently legal: ${marks.join(", ")}; basic energy always legal) — the API's own legality flags lag behind rotation._`;
}

export function truncate(text: string, max = 220): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > max * 0.6 ? lastSpace : max)}…`;
}

const TYPE_INITIALS: Record<string, string> = {
  Grass: "G",
  Fire: "R",
  Water: "W",
  Lightning: "L",
  Psychic: "P",
  Fighting: "F",
  Darkness: "D",
  Metal: "M",
  Fairy: "Y",
  Dragon: "N",
  Colorless: "C",
};

export function costString(cost?: string[]): string {
  if (!cost || cost.length === 0) return "[–]";
  return `[${cost.map((c) => TYPE_INITIALS[c] ?? c[0]).join("")}]`;
}

/** EUR price from cardmarket (trend, falling back to averages). */
export function eurPrice(card: Card): number | undefined {
  const p = card.cardmarket?.prices;
  if (!p) return undefined;
  return p.trendPrice ?? p.averageSellPrice ?? p.avg7 ?? p.avg30 ?? p.lowPrice;
}

/** USD market price from tcgplayer, preferring the plainest variant. */
export function usdPrice(card: Card): number | undefined {
  const variants = card.tcgplayer?.prices;
  if (!variants) return undefined;
  const preferred = ["normal", "holofoil", "reverseHolofoil", "unlimited", "1stEditionHolofoil"];
  for (const key of preferred) {
    const block = variants[key];
    if (block?.market !== undefined) return block.market;
    if (block?.mid !== undefined) return block.mid;
  }
  for (const block of Object.values(variants)) {
    if (block?.market !== undefined) return block.market;
  }
  return undefined;
}

export function fmtEur(value?: number): string {
  return value === undefined ? "–" : `${value.toFixed(2)} €`;
}

export function fmtUsd(value?: number): string {
  return value === undefined ? "–" : `$${value.toFixed(2)}`;
}

/** "0.42 € / $0.51" using whichever markets have data. */
export function priceString(card: Card): string {
  const eur = eurPrice(card);
  const usd = usdPrice(card);
  if (eur === undefined && usd === undefined) return "no price data";
  return [eur !== undefined ? fmtEur(eur) : null, usd !== undefined ? fmtUsd(usd) : null]
    .filter(Boolean)
    .join(" / ");
}

export function setRef(card: Card): string {
  const code = card.set.ptcgoCode ? ` (${card.set.ptcgoCode})` : "";
  return `${card.set.name}${code} ${card.number}`;
}

function attackLine(attack: Attack): string {
  const damage = attack.damage ? ` ${attack.damage}` : "";
  const text = attack.text ? `: ${truncate(attack.text, 180)}` : "";
  return `${costString(attack.cost)} ${attack.name}${damage}${text}`;
}

/** Complete, untruncated card text for get_card's full-detail view. */
export function fullCardText(card: Card): string[] {
  const lines: string[] = [];
  for (const ability of card.abilities ?? []) {
    lines.push(`${ability.type ?? "Ability"} — ${ability.name}: ${ability.text}`);
  }
  for (const attack of card.attacks ?? []) {
    const damage = attack.damage ? ` ${attack.damage}` : "";
    lines.push(`${costString(attack.cost)} ${attack.name}${damage}${attack.text ? `: ${attack.text}` : ""}`);
  }
  for (const rule of card.rules ?? []) lines.push(rule);
  return lines;
}

/** Condensed rules text: abilities + attacks + trainer rules, capped for LLM consumption. */
export function condensedText(card: Card, maxLines = 5): string[] {
  const lines: string[] = [];
  for (const ability of card.abilities ?? []) {
    lines.push(`${ability.type ?? "Ability"} — ${ability.name}: ${truncate(ability.text, 200)}`);
  }
  for (const attack of card.attacks ?? []) {
    lines.push(attackLine(attack));
  }
  for (const rule of card.rules ?? []) {
    // Skip boilerplate reminder text every Supporter/Item/ex card carries.
    if (/^you may play (only 1|any number)/i.test(rule)) continue;
    if (/rule\s*:/i.test(rule) && /take \d+ prize/i.test(rule)) continue;
    lines.push(truncate(rule, 200));
  }
  if (lines.length > maxLines) {
    return [...lines.slice(0, maxLines), `… (${lines.length - maxLines} more lines — use get_card for full text)`];
  }
  return lines;
}

/** Compact one-card block for search results. */
export function compactCardBlock(card: Card, marks: string[]): string {
  const header: string[] = [`**${card.name}**`];
  const kind = [card.supertype, ...(card.subtypes ?? [])].join("/");
  header.push(kind, setRef(card));
  if (card.hp) header.push(`HP ${card.hp}${card.types?.length ? " " + card.types.join("/") : ""}`);
  if (card.regulationMark) header.push(`reg ${card.regulationMark}`);
  header.push(standardBadge(card, marks), priceString(card));
  const lines = condensedText(card).map((l) => `  ${l}`);
  return [`- ${header.join(" · ")} · \`${card.id}\``, ...lines].join("\n");
}
