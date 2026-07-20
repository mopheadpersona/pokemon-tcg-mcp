/**
 * Storage abstraction for the session journal. The tools only ever talk to
 * the Storage interface, so an alternative backend (SQLite, cloud, …) can be
 * added later without touching tool logic. FsStorage is the one real backend:
 * one JSON file per session in SESSIONS_DIR (default ./sessions).
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

export interface Storage {
  /** Stored record names (no extension), sorted ascending. */
  list(): Promise<string[]>;
  /** Raw stored content, or null when the name doesn't exist. */
  read(name: string): Promise<string | null>;
  /** Overwrite (or create) a record. */
  write(name: string, content: string): Promise<void>;
  /**
   * Create a record only if the name is free; false when it already exists.
   * This is the collision-safe primitive session_save relies on — it must be
   * exclusive even on case-insensitive filesystems and across processes.
   */
  create(name: string, content: string): Promise<boolean>;
}

export class FsStorage implements Storage {
  constructor(private dir: string) {}

  async list(): Promise<string[]> {
    try {
      const files = await readdir(this.dir);
      return files
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.slice(0, -".json".length))
        .sort();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  async read(name: string): Promise<string | null> {
    try {
      return await readFile(path.join(this.dir, `${name}.json`), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async write(name: string, content: string): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(path.join(this.dir, `${name}.json`), content, "utf8");
  }

  async create(name: string, content: string): Promise<boolean> {
    await mkdir(this.dir, { recursive: true });
    try {
      // "wx" = exclusive create: fails with EEXIST instead of overwriting,
      // including on case-insensitive filesystems ("Friday" vs "friday").
      await writeFile(path.join(this.dir, `${name}.json`), content, { encoding: "utf8", flag: "wx" });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    }
  }
}

/** Sessions directory: SESSIONS_DIR or ./sessions. */
export function sessionsDir(): string {
  const p = process.env.SESSIONS_DIR?.trim();
  return path.resolve(p && p.length > 0 ? p : "./sessions");
}
