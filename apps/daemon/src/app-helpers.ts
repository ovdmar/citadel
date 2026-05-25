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
    if (!inFlight.has(key)) startBackgroundLoad(cache, key, load, ttlMs);
    return cached.value as T;
  }
  // Cache miss — await synchronously.
  return awaitForegroundLoad(cache, key, load, ttlMs);
}

function startBackgroundLoad<T>(
  cache: PersistentProviderCache,
  key: string,
  load: () => T | Promise<T>,
  ttlMs: number,
): void {
  const token = Symbol("provider-cache-token");
  cache.inFlightTokens.set(key, token);
  const work = (async () => {
    try {
      const value = await load();
      if (cache.inFlightTokens.get(key) === token) {
        cache.set(key, { expiresAt: Date.now() + ttlMs, value, cachedAt: Date.now() });
      }
    } catch (error) {
      console.error(
        `[provider-cache] background refresh for ${key} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      // Only clear the slot we own — if a bust deleted our token, leave the
      // map alone (the bust has authoritative ownership now).
      if (cache.inFlightTokens.get(key) === token) cache.inFlightTokens.delete(key);
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, work);
}

async function awaitForegroundLoad<T>(
  cache: PersistentProviderCache,
  key: string,
  load: () => T | Promise<T>,
  ttlMs: number,
): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return (await existing) as T;
  const token = Symbol("provider-cache-token");
  cache.inFlightTokens.set(key, token);
  const work = (async () => {
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
  })();
  inFlight.set(key, work);
  return work;
}
