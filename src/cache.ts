interface Entry<V> {
  value: V;
  expiresAt: number;
}

/**
 * Small in-memory LRU cache with per-entry TTL. Recency is tracked via Map
 * insertion order (entries are re-inserted on read). Concurrent loads for the
 * same key are deduplicated so a burst of identical requests hits the network
 * only once.
 */
export class TtlLruCache {
  private map = new Map<string, Entry<unknown>>();
  private inflight = new Map<string, Promise<unknown>>();

  constructor(private maxEntries = 500) {}

  get<V>(key: string): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value as V;
  }

  set<V>(key: string, value: V, ttlMs: number): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expiresAt: Date.now() + ttlMs });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  async getOrLoad<V>(key: string, ttlMs: number, loader: () => Promise<V>): Promise<V> {
    const hit = this.get<V>(key);
    if (hit !== undefined) return hit;
    const pending = this.inflight.get(key);
    if (pending) return pending as Promise<V>;
    const promise = loader().then(
      (value) => {
        this.inflight.delete(key);
        this.set(key, value, ttlMs);
        return value;
      },
      (err) => {
        this.inflight.delete(key);
        throw err;
      },
    );
    this.inflight.set(key, promise);
    return promise;
  }
}
