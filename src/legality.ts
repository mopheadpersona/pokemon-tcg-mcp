import type { Card } from "./types.js";

/**
 * Standard legality is computed from regulation marks, NOT from the API's
 * `legalities.standard` field: the live pokemontcg.io data still marks
 * long-rotated regulation-G cards as "Legal" and hasn't flagged the newest
 * regulation-J sets as legal yet. Regulation marks are the authoritative
 * rotation signal, so we derive the current legal window ourselves.
 *
 * Anchor: regulation G ≈ English sets released in 2023 (H→2024, I→2025, …).
 * After the annual rotation (~second week of April) the three newest marks
 * are legal. Override with STANDARD_REGULATION_MARKS=H,I,J if the schedule
 * ever changes.
 */
const MARK_ANCHOR: { letter: string; year: number } = { letter: "G", year: 2023 };
const ROTATION_MONTH = 3; // April (0-indexed)
const ROTATION_DAY = 10;

function markForYear(year: number): string {
  return String.fromCharCode(MARK_ANCHOR.letter.charCodeAt(0) + (year - MARK_ANCHOR.year));
}

export function currentLegalMarks(now: Date = new Date()): string[] {
  const override = process.env.STANDARD_REGULATION_MARKS;
  if (override) {
    const marks = override
      .split(",")
      .map((m) => m.trim().toUpperCase())
      .filter((m) => /^[A-Z]$/.test(m));
    if (marks.length > 0) return marks;
  }
  const year = now.getFullYear();
  const rotated = now.getTime() >= new Date(year, ROTATION_MONTH, ROTATION_DAY).getTime();
  const rotationYear = rotated ? year : year - 1;
  const marks: string[] = [];
  for (let y = rotationYear - 2; y <= rotationYear; y++) marks.push(markForYear(y));
  return marks;
}

export function isBasicEnergy(card: Pick<Card, "supertype" | "subtypes">): boolean {
  return card.supertype?.toLowerCase() === "energy" && (card.subtypes ?? []).some((s) => s.toLowerCase() === "basic");
}

export function isAceSpec(card: Pick<Card, "subtypes">): boolean {
  return (card.subtypes ?? []).some((s) => s.toUpperCase() === "ACE SPEC");
}

export function isStandardLegal(card: Card, marks: string[] = currentLegalMarks()): boolean {
  if (isBasicEnergy(card)) return true;
  if (card.regulationMark && marks.includes(card.regulationMark.toUpperCase())) return true;
  return false;
}

/** Short badge for compact output, e.g. "✓ std" or "✗ std (reg G rotated)". */
export function standardBadge(card: Card, marks: string[] = currentLegalMarks()): string {
  if (isStandardLegal(card, marks)) return "✓ std";
  if (card.regulationMark) return `✗ std (reg ${card.regulationMark} rotated)`;
  return "✗ std (no regulation mark)";
}
