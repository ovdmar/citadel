import type { CitadelConfig } from "@citadel/config";
import type { SqliteStore } from "@citadel/db";
import type { DiagnosticsLogger } from "@citadel/operations";
import type express from "express";
import { buildDiagnosticsSnapshot, streamDiagnosticsBundle } from "./diagnostics-bundle.js";
import type { UiActivityTracker } from "./ui-activity.js";

export function registerDiagnosticsRoutes(input: {
  app: express.Express;
  store: SqliteStore;
  diagnostics: DiagnosticsLogger;
  config: CitadelConfig;
  uiActivity?: UiActivityTracker;
}) {
  const { app, store, diagnostics, config, uiActivity } = input;
  app.get("/api/diagnostics/snapshot", (_req, res) => {
    res.json(buildDiagnosticsSnapshot({ store, diagnostics, config }));
  });

  app.post("/api/diagnostics/client-event", (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    uiActivity?.recordClientEvent(body);
    diagnostics.log("ui-client", clippedString(body.event, "unknown", 80), {
      pageId: clippedString(body.pageId, "", 80),
      path: clippedString(body.path, "", 240),
      href: clippedString(body.href, "", 360),
      visibility: clippedString(body.visibility, "unknown", 40),
      focused: typeof body.focused === "boolean" ? body.focused : null,
      navigationType: clippedString(body.navigationType, "", 40),
      ageMs: finiteNumber(body.ageMs),
      persisted: typeof body.persisted === "boolean" ? body.persisted : null,
      online: typeof body.online === "boolean" ? body.online : null,
      wasDiscarded: typeof body.wasDiscarded === "boolean" ? body.wasDiscarded : null,
      swController: typeof body.swController === "boolean" ? body.swController : null,
      userAgent: clippedString(req.header("user-agent"), "", 240),
    });
    res.status(204).end();
  });

  app.get("/api/diagnostics/bundle.tar.gz", async (_req, res) => {
    try {
      await streamDiagnosticsBundle(res, { store, diagnostics, config });
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

function clippedString(value: unknown, fallback: string, max: number): string {
  if (typeof value !== "string") return fallback;
  return value.length > max ? value.slice(0, max) : value;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
