/**
 * Caching primitives.
 *
 * `LRUCache` is a Map-backed LRU exploiting JS Map's guaranteed insertion
 * ordering: re-inserting a key moves it to the tail, so eviction is just
 * "delete the first key". No linked list, no allocations per get.
 */

export interface CacheEntry<V> {
  value: V;
  expiresAt: number;
}

export interface LRUCacheOptions {
  maxSize?: number;
  /** Default lifetime in ms. 0 disables expiry. */
  ttlMs?: number;
}

export class LRUCache<K, V> {
  private readonly store = new Map<K, CacheEntry<V>>();
  private readonly maxSize: number;
  private readonly ttlMs: number;
  private hits = 0;
  private misses = 0;

  constructor(options: LRUCacheOptions = {}) {
    this.maxSize = options.maxSize ?? 1000;
    this.ttlMs = options.ttlMs ?? 0;
  }

  get(key: K): V | undefined {
    const entry = this.store.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (entry.expiresAt !== 0 && entry.expiresAt < Date.now()) {
      this.store.delete(key);
      this.misses++;
      return undefined;
    }
    // Reinsert to mark as most-recently-used.
    this.store.delete(key);
    this.store.set(key, entry);
    this.hits++;
    return entry.value;
  }

  set(key: K, value: V, ttlMs?: number): void {
    if (this.store.has(key)) this.store.delete(key);
    else if (this.store.size >= this.maxSize) {
      const oldest = this.store.keys().next();
      if (!oldest.done) this.store.delete(oldest.value);
    }
    const effectiveTtl = ttlMs ?? this.ttlMs;
    this.store.set(key, { value, expiresAt: effectiveTtl > 0 ? Date.now() + effectiveTtl : 0 });
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  delete(key: K): boolean {
    return this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
    this.hits = 0;
    this.misses = 0;
  }

  get size(): number {
    return this.store.size;
  }

  stats(): { size: number; maxSize: number; hits: number; misses: number; hitRate: number } {
    const total = this.hits + this.misses;
    return {
      size: this.store.size,
      maxSize: this.maxSize,
      hits: this.hits,
      misses: this.misses,
      hitRate: total === 0 ? 0 : this.hits / total,
    };
  }

  /** Drop expired entries. Cheap to call periodically; O(n) in cache size. */
  prune(): number {
    if (this.ttlMs === 0) return 0;
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of this.store) {
      if (entry.expiresAt !== 0 && entry.expiresAt < now) {
        this.store.delete(key);
        removed++;
      }
    }
    return removed;
  }
}

/**
 * Minimal async cache contract. Satisfied by the in-process LRU and by a Redis
 * adapter alike, so callers never learn which one is in play.
 */
export interface AsyncCache {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
  /** Invalidate every key sharing a prefix — used to bust a namespace on write. */
  deletePrefix(prefix: string): Promise<void>;
  clear(): Promise<void>;
}

/** Default in-process cache. Correct for single instances and for tests. */
export class MemoryAsyncCache implements AsyncCache {
  private readonly lru: LRUCache<string, unknown>;

  constructor(options: LRUCacheOptions = {}) {
    this.lru = new LRUCache<string, unknown>({ maxSize: options.maxSize ?? 5000, ttlMs: options.ttlMs ?? 60_000 });
  }

  async get<T>(key: string): Promise<T | undefined> {
    return this.lru.get(key) as T | undefined;
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    this.lru.set(key, value, ttlSeconds !== undefined ? ttlSeconds * 1000 : undefined);
  }

  async delete(key: string): Promise<void> {
    this.lru.delete(key);
  }

  async deletePrefix(prefix: string): Promise<void> {
    for (const key of this.keys()) {
      if (key.startsWith(prefix)) this.lru.delete(key);
    }
  }

  async clear(): Promise<void> {
    this.lru.clear();
  }

  stats(): ReturnType<LRUCache<string, unknown>['stats']> {
    return this.lru.stats();
  }

  private keys(): string[] {
    // Snapshot before mutating, since deletePrefix deletes while iterating.
    return Array.from((this.lru as unknown as { store: Map<string, unknown> }).store.keys());
  }
}

/** A cache that stores nothing. Useful to disable caching without branching. */
export const nullCache: AsyncCache = {
  async get() {
    return undefined;
  },
  async set() {},
  async delete() {},
  async deletePrefix() {},
  async clear() {},
};

/**
 * Read-through helper with single-flight de-duplication: concurrent misses for
 * the same key share one upstream call instead of stampeding it.
 */
export function createReadThrough(cache: AsyncCache): <T>(
  key: string,
  ttlSeconds: number,
  load: () => Promise<T>,
) => Promise<T> {
  const inflight = new Map<string, Promise<unknown>>();

  return async function readThrough<T>(key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
    const cached = await cache.get<T>(key);
    if (cached !== undefined) return cached;

    const existing = inflight.get(key);
    if (existing) return existing as Promise<T>;

    const promise = (async () => {
      try {
        const value = await load();
        await cache.set(key, value, ttlSeconds);
        return value;
      } finally {
        inflight.delete(key);
      }
    })();

    inflight.set(key, promise);
    return promise;
  };
}
