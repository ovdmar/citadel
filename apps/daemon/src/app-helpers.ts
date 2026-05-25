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
