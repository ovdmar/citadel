import type express from "express";
import type { PersistentProviderCache, ProviderCacheEntry } from "./provider-cache.js";

// Wraps an async route handler so rejections flow into Express's error
// middleware instead of dangling as unhandled promise rejections.
export function asyncRoute(
  handler: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<unknown>,
) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    handler(req, res, next).catch(next);
  };
}

export type ProviderCache = Map<string, ProviderCacheEntry>;

export function bustCacheByPrefixes(providerCache: ProviderCache, prefixes: string[]): number {
  let removed = 0;
  for (const key of Array.from(providerCache.keys())) {
    if (prefixes.some((prefix) => key.startsWith(prefix))) {
      providerCache.delete(key);
      removed += 1;
    }
  }
  return removed;
}

// Memoize a provider lookup with a TTL. Shared between routes that need the
// same expensive computation (e.g. CI status, runtime usage) within the cache
// window. Strict mode: miss/expired entries always await load.
export async function cachedProviderValue<T>(
  cache: ProviderCache,
  key: string,
  load: () => T | Promise<T>,
  ttlMs = 10_000,
): Promise<T> {
  const cached = cache.get(key);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.value as T;
  const value = await load();
  cache.set(key, { expiresAt: now + ttlMs, value, cachedAt: now });
  return value;
}

// Per-key in-flight dedup map. Module-scoped so multiple call sites for the
// same cache key coalesce into a single underlying load call.
const inFlight = new Map<string, Promise<unknown>>();

/**
 * Stale-while-revalidate provider read.
 *
 * - Cache miss: await load synchronously, write result, return it.
 * - Cache hit, fresh (expiresAt > now): return cached value.
 * - Cache hit, stale: return cached value immediately AND kick off a
 *   background load. The background result is only written to the cache if
 *   the per-key Symbol token on `cache.inFlightTokens` hasn't been invalidated
 *   by a concurrent set/delete/clear on that same key. Unrelated mutations on
 *   OTHER keys do NOT affect the token — the per-key invalidation is the
 *   correctness primitive.
 *
 * On background load failure, the in-flight slot is cleared so a future call
 * can retry; the stale cached value is left in place.
 */
export async function cachedProviderWithStaleFallback<T>(input: {
  cache: PersistentProviderCache;
  key: string;
  load: () => T | Promise<T>;
  ttlMs?: number;
}): Promise<T> {
  const { cache, key, load } = input;
  const ttlMs = input.ttlMs ?? 10_000;
  const cached = cache.get(key);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.value as T;
  if (cached) {
    // Stale hit — return cached, refresh in background.
    if (!inFlight.has(key)) {
      const work = performLoad<T>(cache, key, load, ttlMs);
      inFlight.set(key, work);
      // Don't propagate background errors to the foreground caller — the
      // stale value is the best we have. .catch() also marks the rejection
      // as handled so Node doesn't emit unhandledRejection warnings.
      work.catch((error) => {
        console.error(
          `[provider-cache] background refresh for ${key} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
    return cached.value as T;
  }
  // Cache miss. If another caller is mid-load for the same key (e.g. a
  // background refresh fired by a previous stale hit, then the cache was
  // busted), adopt that in-flight promise — it returns the loaded value
  // even if the token-guarded write to cache was skipped. Without this,
  // the foreground caller would receive `undefined` because the previous
  // IIFE never propagated the loaded value.
  const existing = inFlight.get(key);
  if (existing) return (await existing) as T;
  const work = performLoad<T>(cache, key, load, ttlMs);
  inFlight.set(key, work);
  return work;
}

// Single load primitive used by both the stale-hit-background-refresh path
// and the cache-miss-await path. Mints a per-key Symbol token, runs the
// loader, and writes to the cache iff the token still owns the slot at
// completion. Returns the loaded value regardless of whether the cache
// write happened — so callers adopting an in-flight promise from a
// previous (now-busted) refresh still see fresh data.
async function performLoad<T>(
  cache: PersistentProviderCache,
  key: string,
  load: () => T | Promise<T>,
  ttlMs: number,
): Promise<T> {
  const token = Symbol("provider-cache-token");
  cache.inFlightTokens.set(key, token);
  try {
    const value = await load();
    if (cache.inFlightTokens.get(key) === token) {
      cache.set(key, { expiresAt: Date.now() + ttlMs, value, cachedAt: Date.now() });
    }
    return value;
  } finally {
    if (cache.inFlightTokens.get(key) === token) cache.inFlightTokens.delete(key);
    inFlight.delete(key);
  }
}

/** Parse a positive integer from an env var, falling back to `fallback` for
 * unset / non-numeric / non-positive values. Used by every "interval / timeout
 * in ms" knob in the daemon. */
export function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Read a value from the provider cache without calling the loader. Returns
 * the cached value if present and not expired, else undefined. The gh-quota
 * scheduler uses this to serve cache when shouldRefetch says "don't fetch
 * yet" without bypassing the normal cache freshness rules. */
export function peekProviderValue<T>(cache: ProviderCache, key: string): T | undefined {
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value as T;
  return undefined;
}
