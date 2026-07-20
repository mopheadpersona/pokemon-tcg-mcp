import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  cardCountOf,
  listSessions,
  loadSession,
  sanitizeSessionName,
  saveSession,
  uniqueSessionName,
} from "../src/session.js";
import { FsStorage, type Storage } from "../src/storage.js";

/**
 * The alternative-backend proof: session logic runs against any Storage.
 * create() is case-insensitive like the macOS/Windows filesystems FsStorage
 * runs on, so collision handling is exercised the same way.
 */
class MemStorage implements Storage {
  private files = new Map<string, string>();
  async list(): Promise<string[]> {
    return [...this.files.keys()].sort();
  }
  async read(name: string): Promise<string | null> {
    return this.files.get(name) ?? null;
  }
  async write(name: string, content: string): Promise<void> {
    this.files.set(name, content);
  }
  async create(name: string, content: string): Promise<boolean> {
    const clash = [...this.files.keys()].some((k) => k.toLowerCase() === name.toLowerCase());
    if (clash) return false;
    this.files.set(name, content);
    return true;
  }
}

const NOW = new Date("2026-07-20T18:30:00Z");
const LINES = ["2 Slowpoke PBL 29", "1 Slowbro PBL 30", "4 Jacinthe POR 75"];
const DECKS = [{ name: "Mega Slowbro", decklist: "Pokémon: 2\n2 Slowpoke PBL 29\n\nTotal Cards: 2" }];

describe("session names", () => {
  it("sanitizes to file-safe names", () => {
    expect(sanitizeSessionName("friday night @ ken's!")).toBe("friday-night-ken-s");
    expect(sanitizeSessionName("../../etc/passwd")).toBe("etc-passwd");
    expect(sanitizeSessionName("  ")).toBe("");
  });

  it("appends -2, -3 … on collision", () => {
    expect(uniqueSessionName("2026-07-20", [])).toBe("2026-07-20");
    expect(uniqueSessionName("2026-07-20", ["2026-07-20"])).toBe("2026-07-20-2");
    expect(uniqueSessionName("2026-07-20", ["2026-07-20", "2026-07-20-2"])).toBe("2026-07-20-3");
  });
});

describe("session save/list/load over an in-memory Storage", () => {
  it("round-trips lines and decks", async () => {
    const storage = new MemStorage();
    const { record } = await saveSession(storage, { name: "game-night", lines: LINES, decks: DECKS, now: NOW });
    expect(record.name).toBe("game-night");
    expect(record.savedAt).toBe(NOW.toISOString());

    const loaded = await loadSession(storage, "game-night");
    expect(loaded).not.toBeNull();
    expect(loaded!.lines).toEqual(LINES);
    expect(loaded!.decks).toEqual(DECKS);
  });

  it("defaults the name to the LOCAL ISO date and appends -2 on collision", async () => {
    const storage = new MemStorage();
    const localDate = `${NOW.getFullYear()}-${String(NOW.getMonth() + 1).padStart(2, "0")}-${String(NOW.getDate()).padStart(2, "0")}`;
    const first = await saveSession(storage, { lines: LINES, now: NOW });
    expect(first.record.name).toBe(localDate);
    expect(first.renamedFrom).toBeUndefined();

    const second = await saveSession(storage, { lines: LINES, now: NOW });
    expect(second.record.name).toBe(`${localDate}-2`);
    expect(second.renamedFrom).toBe(localDate);
  });

  it("treats name collisions case-insensitively (macOS/Windows filesystems)", async () => {
    const storage = new MemStorage();
    await saveSession(storage, { name: "friday", lines: LINES, now: NOW });
    const second = await saveSession(storage, { name: "Friday", lines: ["1 Iono PAL 185"], now: NOW });
    expect(second.record.name).toBe("Friday-2");
    // The first session survives untouched.
    const first = await loadSession(storage, "friday");
    expect(first!.lines).toEqual(LINES);
  });

  it("keeps stored names loadable even past the length cap (suffix appended after capping)", async () => {
    const storage = new MemStorage();
    const long = "x".repeat(85);
    const first = await saveSession(storage, { name: long, lines: LINES, now: NOW });
    const second = await saveSession(storage, { name: long, lines: ["1 Iono PAL 185"], now: NOW });
    expect(second.record.name).toBe(`${first.record.name}-2`);
    const loaded = await loadSession(storage, second.record.name);
    expect(loaded!.lines).toEqual(["1 Iono PAL 185"]);
  });

  it("lists sessions with card counts and deck names, newest first", async () => {
    const storage = new MemStorage();
    await saveSession(storage, { name: "early", lines: ["1 Slowpoke PBL 29"], now: new Date("2026-07-19T10:00:00Z") });
    await saveSession(storage, { name: "late", lines: LINES, decks: DECKS, now: NOW });

    const { sessions, warnings } = await listSessions(storage);
    expect(warnings).toEqual([]);
    expect(sessions.map((s) => s.name)).toEqual(["late", "early"]);
    expect(sessions[0]).toMatchObject({ cardCount: 7, deckNames: ["Mega Slowbro"] });
    expect(sessions[1]).toMatchObject({ cardCount: 1, deckNames: [] });
  });

  it("skips unreadable records with a warning instead of failing", async () => {
    const storage = new MemStorage();
    await storage.write("broken", "{not json");
    await storage.write("nulled", "null");
    await storage.write("arrayed", "[1, 2]");
    await saveSession(storage, { name: "ok", lines: LINES, now: NOW });
    const { sessions, warnings } = await listSessions(storage);
    expect(sessions.map((s) => s.name)).toEqual(["ok"]);
    expect(warnings.some((w) => w.includes("broken"))).toBe(true);
    expect(warnings.some((w) => w.includes("nulled"))).toBe(true);
    expect(warnings.some((w) => w.includes("arrayed"))).toBe(true);
  });

  it("rejects path-shaped session names on load", async () => {
    const storage = new MemStorage();
    await saveSession(storage, { name: "ok", lines: LINES, now: NOW });
    expect(await loadSession(storage, "../../etc/passwd")).toBeNull();
    expect(await loadSession(storage, ".hidden")).toBeNull();
  });

  it("returns null for a missing session", async () => {
    expect(await loadSession(new MemStorage(), "nope")).toBeNull();
  });
});

describe("FsStorage", () => {
  it("round-trips through real JSON files and lists an empty dir as []", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "ptcg-sessions-")), "sessions");
    const storage = new FsStorage(dir); // dir does not exist yet
    expect(await storage.list()).toEqual([]);

    const { record } = await saveSession(storage, { name: "fs-check", lines: LINES, decks: DECKS, now: NOW });
    expect(await storage.list()).toEqual(["fs-check"]);

    const loaded = await loadSession(storage, "fs-check");
    expect(loaded).toEqual(record);
  });
});

describe("cardCountOf", () => {
  it("sums the quantities of parseable lines", () => {
    expect(cardCountOf(LINES)).toBe(7);
    expect(cardCountOf([])).toBe(0);
  });
});
