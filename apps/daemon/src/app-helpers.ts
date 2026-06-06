import type express from "express";

// Wraps an async route handler so rejections flow into Express's error
// middleware instead of dangling as unhandled promise rejections.
export function asyncRoute(
  handler: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<unknown>,
) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    handler(req, res, next).catch(next);
  };
}

export type ProviderCache = Map<string, { expiresAt: number; value: unknown }>;

// Memoize a provider lookup with a TTL. Shared between routes that need the
// same expensive computation (e.g. CI status, runtime usage) within the cache
// window.
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
  cache.set(key, { expiresAt: now + ttlMs, value });
  return value;
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
