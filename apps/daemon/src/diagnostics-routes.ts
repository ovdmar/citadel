import type { CitadelConfig } from "@citadel/config";
import type { SqliteStore } from "@citadel/db";
import type { DiagnosticsLogger } from "@citadel/operations";
import type { TtydManager } from "@citadel/terminal";
import type express from "express";
import { buildDiagnosticsSnapshot, streamDiagnosticsBundle } from "./diagnostics-bundle.js";

export function registerDiagnosticsRoutes(input: {
  app: express.Express;
  store: SqliteStore;
  ttyd: TtydManager;
  diagnostics: DiagnosticsLogger;
  config: CitadelConfig;
}) {
  const { app, store, ttyd, diagnostics, config } = input;
  app.get("/api/diagnostics/snapshot", (_req, res) => {
    res.json(buildDiagnosticsSnapshot({ store, ttyd, diagnostics, config }));
  });
  app.get("/api/diagnostics/bundle.tar.gz", async (_req, res) => {
    try {
      await streamDiagnosticsBundle(res, { store, ttyd, diagnostics, config });
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json({ error: error instanceof Error ? error.message : "diagnostics_bundle_failed" });
      } else {
        try {
          res.end();
        } catch {
          /* ignore */
        }
      }
    }
  });
}
