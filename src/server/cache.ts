/**
 * Bounded LRU + TTL cache to prevent unbounded memory growth / DoS
 * in in-memory caches such as `scanCache`.
 */
export interface BoundedTtlCacheOptions {
  maxEntries: number;
  ttlMs: number;
  nowMs?: () => number;
}

interface CacheEntry<V> {
  value: V;
  expiresAt: number;
}

export class BoundedTtlCache<K, V> {
  private readonly store = new Map<K, CacheEntry<V>>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly nowMs: () => number;

  constructor(opts: BoundedTtlCacheOptions) {
    this.maxEntries = Math.max(1, Math.floor(opts.maxEntries));
    this.ttlMs = Math.max(1, Math.floor(opts.ttlMs));
    this.nowMs = opts.nowMs ?? (() => Date.now());
  }

  get size(): number {
    this.pruneExpired();
    return this.store.size;
  }

  get(key: K): V | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (this.nowMs() >= entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    // Refresh LRU order on hit
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  set(key: K, value: V): this {
    const now = this.nowMs();
    this.pruneExpired(now);
    if (this.store.has(key)) {
      this.store.delete(key);
    }
    this.store.set(key, { value, expiresAt: now + this.ttlMs });
    while (this.store.size > this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey === undefined) break;
      this.store.delete(oldestKey);
    }
    return this;
  }

  delete(key: K): boolean {
    return this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  values(): IterableIterator<V> {
    this.pruneExpired();
    const list: V[] = [];
    for (const entry of this.store.values()) {
      list.push(entry.value);
    }
    return list[Symbol.iterator]();
  }

  entries(): IterableIterator<[K, V]> {
    this.pruneExpired();
    const list: Array<[K, V]> = [];
    for (const [k, entry] of this.store.entries()) {
      list.push([k, entry.value]);
    }
    return list[Symbol.iterator]();
  }

  pruneExpired(now = this.nowMs()): number {
    let removed = 0;
    for (const [key, entry] of this.store.entries()) {
      if (now >= entry.expiresAt) {
        this.store.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}
