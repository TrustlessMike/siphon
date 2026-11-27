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

/**
 * In-flight promise coalescer with optional BoundedTtlCache backing.
 * Concurrent identical callers share a single upstream request; completed values
 * are optionally cached for the cache's TTL while `refresh: true` bypasses both
 * cache reads and existing in-flight promises.
 */
export class InFlightCoalescer<K, V> {
  private readonly inFlight = new Map<K, Promise<V>>();
  private readonly cache?: BoundedTtlCache<K, V>;

  constructor(cache?: BoundedTtlCache<K, V>) {
    this.cache = cache;
  }

  get inFlightSize(): number {
    return this.inFlight.size;
  }

  getCached(key: K): V | undefined {
    return this.cache?.get(key);
  }

  clear(): void {
    this.inFlight.clear();
    this.cache?.clear();
  }

  async run(
    key: K,
    factory: () => Promise<V>,
    opts?: { refresh?: boolean; cachePredicate?: (value: V) => boolean }
  ): Promise<{ value: V; cached: boolean; coalesced: boolean }> {
    const refresh = Boolean(opts?.refresh);

    if (!refresh && this.cache) {
      const hit = this.cache.get(key);
      if (hit !== undefined) {
        return { value: hit, cached: true, coalesced: false };
      }
    }

    if (!refresh) {
      const existing = this.inFlight.get(key);
      if (existing) {
        const value = await existing;
        return { value, cached: false, coalesced: true };
      }
    }

    let promise!: Promise<V>;
    promise = (async () => {
      try {
        const value = await factory();
        if (this.cache && (!opts?.cachePredicate || opts.cachePredicate(value))) {
          this.cache.set(key, value);
        }
        return value;
      } finally {
        if (this.inFlight.get(key) === promise) {
          this.inFlight.delete(key);
        }
      }
    })();

    this.inFlight.set(key, promise);
    const value = await promise;
    return { value, cached: false, coalesced: false };
  }
}
