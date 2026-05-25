import type { RuntimeConfig, UsageProviderConfig } from "@citadel/config";
import { collectRuntimeUsage } from "@citadel/providers";
import { listRuntimeHealth } from "@citadel/runtimes";
import type express from "express";

type AsyncHandler = (
  handler: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<unknown>,
) => (req: express.Request, res: express.Response, next: express.NextFunction) => void;

type CachedProvider = <T>(key: string, load: () => T | Promise<T>, ttlMs?: number) => Promise<T>;

// Returns an Express handler factory for GET / POST runtime usage endpoints.
// Extracted from app.ts so the routes don't push the file past the size
// budget; the closure over config/cache stays explicit via the deps arg.
export function runtimeUsageHandlerFactory(deps: {
  runtimes: RuntimeConfig[];
  usageProviders: UsageProviderConfig[];
  providerCache: Map<string, { expiresAt: number; value: unknown }>;
  cachedProvider: CachedProvider;
  asyncRoute: AsyncHandler;
}) {
  return (options: { force: boolean }) =>
    deps.asyncRoute(async (req, res) => {
      const runtimeId = req.params.runtimeId;
      if (typeof runtimeId !== "string") return res.status(400).json({ error: "runtime_id_required" });
      const runtime = deps.runtimes.find((candidate) => candidate.id === runtimeId);
      if (!runtime) return res.status(404).json({ error: "runtime_not_found" });

      const runtimeHealth = listRuntimeHealth(deps.runtimes).find((entry) => entry.id === runtimeId);
      const checkedAt = new Date().toISOString();
      // Health gate: a runtime that isn't healthy has no usage to fetch. We
      // short-circuit BEFORE spawning anything (tmux, PTY, external command).
      if (!runtimeHealth || runtimeHealth.health !== "healthy") {
        return res.json({
          usage: {
            runtimeId,
            providerId: "usage-unavailable",
            source: "health-gate",
            status: "unavailable" as const,
            reason: runtimeHealth?.healthReason ?? "Runtime is not healthy",
            categories: [],
            checkedAt,
          },
        });
      }
      // Capability gate: only runtimes that advertise supportsUsage have a
      // fetcher (built-in or external). Same logic, different reason.
      if (!runtimeHealth.capabilities.supportsUsage) {
        return res.json({
          usage: {
            runtimeId,
            providerId: "usage-unsupported",
            source: "unsupported",
            status: "unavailable" as const,
            reason: "Runtime does not support usage reporting",
            categories: [],
            checkedAt,
          },
        });
      }

      const provider = deps.usageProviders.find((candidate) => candidate.runtimeId === runtimeId);
      const cacheKey = `usage:${runtimeId}:${provider?.id ?? "builtin"}`;
      if (options.force) deps.providerCache.delete(cacheKey);
      const usage = await deps.cachedProvider(
        cacheKey,
        () =>
          collectRuntimeUsage({
            runtimeId,
            command: runtime.command,
            args: runtime.args,
            externalProvider: provider,
          }),
        5 * 60_000,
      );
      res.json({ usage });
    });
}
