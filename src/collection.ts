/**
 * Local collection store: a plain text file in TCG Live decklist line format
 * ("4 Slowpoke PBL 29"), `#` comments allowed, section headers ignored.
 * Parsing and mutation are pure functions over the file text — unit tested in
 * test/collection.test.ts. File I/O lives in the thin load/save helpers.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { normalizeName, normNum, parseDecklist, type DeckEntry } from "./deck.js";

export interface ParsedCollection {
  entries: DeckEntry[];
  warnings: string[];
}

/** One card-line's worth of change (same shape the decklist parser produces). */
export interface LineSpec {
  count: number;
  name: string;
  setCode?: string;
  number?: string;
}

/** Strip a `#` comment; card names never contain '#'. */
function stripComment(line: string): string {
  const i = line.indexOf("#");
  return i >= 0 ? line.slice(0, i) : line;
}

/** Parse collection text: card entries + warnings; comments/sections ignored. */
export function parseCollection(text: string): ParsedCollection {
  const stripped = text
    .split(/\r?\n/)
    .map(stripComment)
    .join("\n");
  const parsed = parseDecklist(stripped);
  // "Total Cards" reconciliation is a decklist concept — meaningless for a
  // growing collection file, so that warning is dropped.
  return { entries: parsed.entries, warnings: parsed.warnings.filter((w) => !w.includes("Total Cards")) };
}

/** Identity of a printing within the collection file. */
function printingKey(spec: { name: string; setCode?: string; number?: string }): string {
  return `${normalizeName(spec.name)}|${spec.setCode?.toUpperCase() ?? ""}|${normNum(spec.number ?? "")}`;
}

/** Canonical text line for a spec, e.g. "4 Slowpoke PBL 29". */
export function formatLine(spec: LineSpec): string {
  const parts = [String(spec.count), spec.name];
  if (spec.setCode) parts.push(spec.setCode);
  if (spec.number) parts.push(spec.number);
  return parts.join(" ");
}

interface FileLine {
  raw: string;
  /** Present when the (comment-stripped) line parses as exactly one card entry. */
  entry?: DeckEntry;
  /** Trailing comment (with leading whitespace) to reattach after edits. */
  comment: string;
}

interface FileStructure {
  lines: FileLine[];
  /** The file's dominant line ending, preserved on render. */
  eol: string;
}

function structure(text: string): FileStructure {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/).map((raw) => {
    const hash = raw.indexOf("#");
    const code = hash >= 0 ? raw.slice(0, hash) : raw;
    const comment = hash >= 0 ? " " + raw.slice(hash) : "";
    // Warnings are fine ("no set code before number …") as long as the line
    // yields exactly one entry — otherwise list and remove would disagree
    // about which lines exist.
    const parsed = parseDecklist(code);
    const entry = parsed.entries.length === 1 ? parsed.entries[0] : undefined;
    return { raw, entry, comment };
  });
  return { lines, eol };
}

function render(structureData: FileStructure): string {
  return structureData.lines.map((l) => l.raw).join(structureData.eol);
}

function describe(spec: { name: string; setCode?: string; number?: string }): string {
  if (!spec.setCode) return spec.name;
  return `${spec.name} (${[spec.setCode, spec.number].filter(Boolean).join(" ")})`;
}

/**
 * Add copies: increment a matching existing line (same name + set + number)
 * or append a new one. Comments, blanks and unrelated lines are preserved
 * byte-for-byte.
 */
export function addToCollectionText(text: string, additions: LineSpec[]): { text: string; notes: string[] } {
  const data = structure(text);
  const { lines } = data;
  const notes: string[] = [];
  let changed = false;

  for (const spec of additions) {
    if (spec.count <= 0) {
      notes.push(`${describe(spec)}: count ${spec.count} — ignored.`);
      continue;
    }
    const key = printingKey(spec);
    const match = lines.find((l) => l.entry && printingKey(l.entry) === key);
    changed = true;
    if (match?.entry) {
      const newCount = match.entry.count + spec.count;
      match.raw =
        formatLine({ count: newCount, name: match.entry.name, setCode: match.entry.setCode, number: match.entry.number }) +
        match.comment;
      match.entry = { ...match.entry, count: newCount };
      notes.push(`Added ${spec.count} × ${describe(spec)} — now ${newCount} in the collection.`);
    } else {
      // Append after the last non-empty line so the file doesn't grow gaps.
      let insertAt = lines.length;
      while (insertAt > 0 && lines[insertAt - 1].raw.trim() === "") insertAt--;
      const raw = formatLine(spec);
      const parsed = parseDecklist(raw);
      lines.splice(insertAt, 0, { raw, entry: parsed.entries[0], comment: "" });
      notes.push(`Added ${spec.count} × ${describe(spec)} (new line).`);
    }
  }

  return { text: changed ? render(data) : text, notes };
}

/**
 * Remove copies: decrement matching lines, dropping a line when it reaches 0.
 * A name-only spec matching several distinct printings is ambiguous — no
 * change, and the note lists the candidate lines. Over-removal clamps to 0
 * with a note.
 */
export function removeFromCollectionText(
  text: string,
  removals: LineSpec[],
): { text: string; notes: string[] } {
  const data = structure(text);
  const { lines } = data;
  const notes: string[] = [];
  let changed = false;

  for (const spec of removals) {
    if (spec.count <= 0) {
      notes.push(`${describe(spec)}: count ${spec.count} — ignored.`);
      continue;
    }
    let candidates: FileLine[];
    if (spec.setCode && spec.number) {
      const key = printingKey(spec);
      candidates = lines.filter((l) => l.entry && printingKey(l.entry) === key);
    } else {
      candidates = lines.filter((l) => l.entry && normalizeName(l.entry.name) === normalizeName(spec.name));
    }

    if (candidates.length === 0) {
      notes.push(`No collection line matches "${describe(spec)}" — nothing removed.`);
      continue;
    }
    // Several lines are only ambiguous when they are DIFFERENT printings;
    // duplicate lines of the same printing are one stack.
    const distinctKeys = new Set(candidates.map((l) => printingKey(l.entry!)));
    if (distinctKeys.size > 1) {
      const listing = candidates.map((l) => formatLine(l.entry!)).join(", ");
      notes.push(
        `"${spec.name}" is ambiguous in the collection — matches: ${listing}. Specify set code and number; no change made.`,
      );
      continue;
    }

    const first = candidates[0].entry!;
    const owned = candidates.reduce((sum, l) => sum + l.entry!.count, 0);
    const removable = Math.min(spec.count, owned);
    if (removable < spec.count) {
      notes.push(`${describe(first)}: only ${owned} in the collection — removed all ${owned}.`);
    } else {
      notes.push(
        `Removed ${removable} × ${describe(first)}${owned - removable > 0 ? ` — ${owned - removable} left` : " — line dropped"}.`,
      );
    }

    let remaining = removable;
    for (const line of candidates) {
      if (remaining <= 0) break;
      const entry = line.entry!;
      const take = Math.min(entry.count, remaining);
      remaining -= take;
      changed = true;
      const newCount = entry.count - take;
      if (newCount <= 0) {
        lines.splice(lines.indexOf(line), 1);
      } else {
        line.raw =
          formatLine({ count: newCount, name: entry.name, setCode: entry.setCode, number: entry.number }) + line.comment;
        line.entry = { ...entry, count: newCount };
      }
    }
  }

  return { text: changed ? render(data) : text, notes };
}

/** Collection file path: POKEMON_COLLECTION_PATH or ./collection.txt. */
export function collectionFilePath(): string {
  const p = process.env.POKEMON_COLLECTION_PATH?.trim();
  return path.resolve(p && p.length > 0 ? p : "./collection.txt");
}

/** File text, or "" if the file doesn't exist yet. */
export async function loadCollectionText(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

export async function saveCollectionText(filePath: string, text: string): Promise<void> {
  await writeFile(filePath, text, "utf8");
}
