import type { CitadelConfig } from "@citadel/config";
import { SystemResourceTypeSchema } from "@citadel/contracts";
import type express from "express";
import type { asyncRoute as AsyncRoute } from "./app-helpers.js";
import { collectSystemHealthSnapshot } from "./system-health.js";
import { collectSystemResourceOffenders } from "./system-resource-offenders.js";

export function registerSystemHealthRoute(input: {
  app: express.Express;
  config: CitadelConfig;
  asyncRoute: typeof AsyncRoute;
}): void {
  const { app, config, asyncRoute } = input;
  app.get(
    "/api/system-health",
    asyncRoute(async (_req, res) => {
      res.json({ systemHealth: collectSystemHealthSnapshot({ diskPath: config.dataDir }) });
    }),
  );
  app.get(
    "/api/system-health/resources/:resource/offenders",
    asyncRoute(async (req, res) => {
      const resource = SystemResourceTypeSchema.safeParse(req.params.resource);
      if (!resource.success) return res.status(400).json({ error: "invalid_resource_type" });
      res.json({
        breakdown: await collectSystemResourceOffenders({ resource: resource.data, dataDir: config.dataDir }),
      });
    }),
  );
}
