import type { CitadelConfig } from "@citadel/config";
import { collectRuntimeUsage } from "@citadel/providers";
import { listRuntimeHealth } from "@citadel/runtimes";
import type express from "express";

type AsyncRoute = (
  handler: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<unknown>,
) => (req: express.Request, res: express.Response, next: express.NextFunction) => void;

type ProviderCache = {
  delete(key: string): void;
};

type CachedProvider = <T>(key: string, load: () => T | Promise<T>, ttlMs?: number) => Promise<T>;

// Health- and capability-gated runtime usage routes (GET reads through the
// cache, POST /refresh forces a re-fetch). Kept in its own module so app.ts
// stays under the project's 800-line ceiling.
export function registerRuntimeUsageRoutes(input: {
  app: express.Express;
  config: CitadelConfig;
  asyncRoute: AsyncRoute;
  providerCache: ProviderCache;
  cachedProvider: CachedProvider;
}): void {
  const { app, config, asyncRoute, providerCache, cachedProvider } = input;

  const handler = (options: { force: boolean }) =>
    asyncRoute(async (req, res) => {
      const runtimeId = req.params.runtimeId;
      if (typeof runtimeId !== "string") return res.status(400).json({ error: "runtime_id_required" });
      const runtime = config.agentRuntimes.find((candidate) => candidate.id === runtimeId);
      if (!runtime) return res.status(404).json({ error: "runtime_not_found" });

      const runtimeHealth = listRuntimeHealth(config.agentRuntimes).find((entry) => entry.id === runtimeId);
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

      const provider = config.usageProviders.find((candidate) => candidate.runtimeId === runtimeId);
      const cacheKey = `usage:${runtimeId}:${provider?.id ?? "builtin"}`;
      if (options.force) providerCache.delete(cacheKey);
      const usage = await cachedProvider(
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

  app.get("/api/runtimes/:runtimeId/usage", handler({ force: false }));
  app.post("/api/runtimes/:runtimeId/usage/refresh", handler({ force: true }));
}
