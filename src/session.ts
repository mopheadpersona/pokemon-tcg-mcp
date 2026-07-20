/**
 * Session journal for the kitchen-table workflow: what was scanned and what
 * was built, as one dumb JSON record per session. All logic is over the
 * Storage interface — no direct file I/O here. Unit tested in
 * test/session.test.ts against an in-memory Storage.
 */
import { parseDecklist } from "./deck.js";
import type { Storage } from "./storage.js";

export interface SessionDeck {
  name: string;
  /** TCG Live decklist text, same format check_deck accepts. */
  decklist: string;
}

export interface SessionRecord {
  name: string;
  /** ISO timestamp of the save. */
  savedAt: string;
  /** Card lines in TCG Live format, same as collection_add accepts. */
  lines: string[];
  decks?: SessionDeck[];
}

export interface SessionSummary {
  name: string;
  savedAt: string;
  cardCount: number;
  deckNames: string[];
}

/**
 * File-safe session name: keep word chars, dots and dashes; everything else
 * becomes '-'. The length cap runs BEFORE the trailing strip so outputs are
 * fixed points of this function (sanitize(sanitize(x)) === sanitize(x)), and
 * the cap leaves room for uniqueSessionName's -N suffix within a safe length.
 */
export function sanitizeSessionName(raw: string): string {
  return raw
    .trim()
    .replace(/[^\w.-]+/g, "-")
    .slice(0, 72)
    .replace(/^[-.]+|[-.]+$/g, "");
}

/**
 * base, then base-2, base-3 … skipping names already taken. Comparison is
 * case-insensitive: macOS/Windows filesystems treat "Friday" and "friday" as
 * the same file. (saveSession additionally guards with Storage.create, which
 * is exclusive — this fast path just avoids pointless create attempts.)
 */
export function uniqueSessionName(base: string, existing: readonly string[]): string {
  const taken = new Set(existing.map((n) => n.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

export function cardCountOf(lines: readonly string[]): number {
  return parseDecklist(lines.join("\n")).totalCards;
}

/** The LOCAL calendar date — a Friday-evening session in the Americas must not be named with tomorrow's UTC date. */
function localIsoDate(now: Date): string {
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${mm}-${dd}`;
}

export async function saveSession(
  storage: Storage,
  opts: { name?: string; lines: string[]; decks?: SessionDeck[]; now?: Date },
): Promise<{ record: SessionRecord; renamedFrom?: string }> {
  const now = opts.now ?? new Date();
  const requested = sanitizeSessionName(opts.name ?? "") || localIsoDate(now);
  // uniqueSessionName is the fast path; Storage.create is the real guard —
  // exclusive even against concurrent saves and case-folding filesystems.
  const taken = [...(await storage.list())];
  for (let attempt = 0; attempt < 1000; attempt++) {
    const name = uniqueSessionName(requested, taken);
    const record: SessionRecord = {
      name,
      savedAt: now.toISOString(),
      lines: opts.lines,
      ...(opts.decks && opts.decks.length > 0 ? { decks: opts.decks } : {}),
    };
    if (await storage.create(name, JSON.stringify(record, null, 2) + "\n")) {
      return { record, renamedFrom: name === requested ? undefined : requested };
    }
    taken.push(name);
  }
  throw new Error(`could not find a free session name for "${requested}"`);
}

/** Guard against path-shaped names; stored names (always sanitized) pass unchanged. */
function isSafeSessionName(name: string): boolean {
  return name.length > 0 && name.length <= 120 && !/[/\\]/.test(name) && !name.includes("..") && !name.startsWith(".");
}

export async function loadSession(storage: Storage, name: string): Promise<SessionRecord | null> {
  // Read the name as given (so anything session_list shows is loadable) and
  // only fall back to the sanitized form for hand-typed variants.
  const candidates = isSafeSessionName(name) ? [name, sanitizeSessionName(name)] : [sanitizeSessionName(name)];
  let content: string | null = null;
  for (const candidate of [...new Set(candidates)]) {
    if (!isSafeSessionName(candidate)) continue;
    content = await storage.read(candidate);
    if (content !== null) break;
  }
  if (content === null) return null;
  const parsed: unknown = JSON.parse(content);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`"${name}" does not contain a session record`);
  }
  const record = parsed as Partial<SessionRecord>;
  return {
    name: record.name ?? name,
    savedAt: record.savedAt ?? "unknown",
    lines: Array.isArray(record.lines) ? record.lines : [],
    ...(Array.isArray(record.decks) && record.decks.length > 0 ? { decks: record.decks } : {}),
  };
}

export async function listSessions(
  storage: Storage,
): Promise<{ sessions: SessionSummary[]; warnings: string[] }> {
  const names = await storage.list();
  const sessions: SessionSummary[] = [];
  const warnings: string[] = [];
  for (const name of names) {
    try {
      const record = await loadSession(storage, name);
      if (!record) {
        warnings.push(`session "${name}" is listed but could not be read back — skipped`);
        continue;
      }
      sessions.push({
        name,
        savedAt: record.savedAt,
        cardCount: cardCountOf(record.lines),
        deckNames: (record.decks ?? []).map((d) => d.name),
      });
    } catch (err) {
      warnings.push(`session "${name}" is unreadable (${err instanceof Error ? err.message : err}) — skipped`);
    }
  }
  // Newest first — savedAt is ISO, so string order is time order; anything
  // without a real timestamp sorts last, not first.
  const sortKey = (s: SessionSummary): string => (/^\d{4}-/.test(s.savedAt) ? s.savedAt : "");
  sessions.sort((a, b) => sortKey(b).localeCompare(sortKey(a)));
  return { sessions, warnings };
}
