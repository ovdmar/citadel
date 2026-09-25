import type { CitadelConfig } from "@citadel/config";
import type express from "express";
import type { asyncRoute as AsyncRoute } from "./app-helpers.js";
import { collectSystemHealthSnapshot } from "./system-health.js";

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
}
