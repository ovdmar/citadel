import type { CitadelConfig } from "@citadel/config";
import { collectRuntimeUsage } from "@citadel/providers";
import { listRuntimeHealth } from "@citadel/runtimes";
import type express from "express";

type AsyncRoute = (
  handler: (req: express.Request, res: express.Response) => Promise<unknown>,
) => express.RequestHandler;

export function registerRuntimeUsageRoutes(input: {
  app: express.Express;
  config: CitadelConfig;
  asyncRoute: AsyncRoute;
  cachedProvider: <T>(key: string, fn: () => Promise<T>, ttlMs: number) => Promise<T>;
  providerCache: Map<string, { expiresAt: number; value: unknown }>;
}) {
  const { app, config, asyncRoute, cachedProvider, providerCache } = input;

  const handler = (options: { force: boolean }) =>
    asyncRoute(async (req, res) => {
      const runtimeId = req.params.runtimeId;
      if (typeof runtimeId !== "string") return res.status(400).json({ error: "runtime_id_required" });
      const runtime = config.runtimes.find((candidate) => candidate.id === runtimeId);
      if (!runtime) return res.status(404).json({ error: "runtime_not_found" });

      const runtimeHealth = listRuntimeHealth(config.runtimes).find((entry) => entry.id === runtimeId);
      const checkedAt = new Date().toISOString();
      const unavailable = (providerId: string, source: string, reason: string) => ({
        usage: {
          runtimeId,
          providerId,
          source,
          status: "unavailable" as const,
          reason,
          categories: [],
          checkedAt,
        },
      });
      // Health-gate short-circuits BEFORE spawning anything; capability gate
      // catches runtimes without a usage fetcher (built-in or external).
      if (!runtimeHealth || runtimeHealth.health !== "healthy") {
        return res.json(
          unavailable("usage-unavailable", "health-gate", runtimeHealth?.healthReason ?? "Runtime is not healthy"),
        );
      }
      if (!runtimeHealth.capabilities.supportsUsage) {
        return res.json(unavailable("usage-unsupported", "unsupported", "Runtime does not support usage reporting"));
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
