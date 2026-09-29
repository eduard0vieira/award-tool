// When Smiles blocks the IP mid-sweep, the search is retried minutes later and
// used to start from scratch, spending the budget again on days that had already
// come in. Keeping each day's response lets the retry ask only for what is missing.
//
// Not a database: it goes away when the server restarts, on purpose. The goal is
// getting through a block window, not keeping history.
export type CacheEntry<T> = { value: T; storedAt: number };

export class ExpiringCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  constructor(
    private readonly ttlMs: number,
    // Caps memory on a year-long sweep; when full, the oldest entry goes.
    private readonly maxEntries = 5000,
  ) {}

  get(key: string): T | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (Date.now() - entry.storedAt > this.ttlMs) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, storedAt: Date.now() });
  }

  get size(): number {
    return this.entries.size;
  }
}
