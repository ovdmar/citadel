import type { CitadelConfig } from "@citadel/config";
import type { SqliteStore } from "@citadel/db";
import type { DiagnosticsLogger } from "@citadel/operations";
import type { createTtydManager } from "@citadel/terminal";
import type express from "express";
import { buildDiagnosticsSnapshot, streamDiagnosticsBundle } from "./diagnostics-bundle.js";

type TtydManager = ReturnType<typeof createTtydManager>;

function clippedString(value: unknown, fallback: string, max: number): string {
  if (typeof value !== "string") return fallback;
  return value.length > max ? value.slice(0, max) : value;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function registerDiagnosticsRoutes(input: {
  app: express.Express;
  store: SqliteStore;
  ttyd: TtydManager;
  diagnostics: DiagnosticsLogger;
  config: CitadelConfig;
}) {
  const { app, store, ttyd, diagnostics, config } = input;
  // Diagnostics surface. /snapshot returns the in-memory ring + a small
  // structured snapshot of "what the daemon thinks the world looks like"
  // (sessions/workspaces/ttyd inventory/live tmux session names). /bundle
  // streams a tar.gz that includes the JSONL file(s) on disk plus that same
  // snapshot — what the user emails over when reporting "all my sessions
  // died".
  app.get("/api/diagnostics/snapshot", (_req, res) => {
    res.json(buildDiagnosticsSnapshot({ store, ttyd, diagnostics, config }));
  });
  app.post("/api/diagnostics/client-event", (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    diagnostics.log("ui-client", clippedString(body.event, "unknown", 80), {
      pageId: clippedString(body.pageId, "", 80),
      path: clippedString(body.path, "", 240),
      href: clippedString(body.href, "", 360),
      visibility: clippedString(body.visibility, "unknown", 40),
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
