import type { DiagnosticsLogger } from "@citadel/operations";
import type express from "express";

function clippedString(value: unknown, fallback: string, max: number): string {
  if (typeof value !== "string") return fallback;
  return value.length > max ? value.slice(0, max) : value;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function registerDiagnosticsClientRoute(input: { app: express.Express; diagnostics: DiagnosticsLogger }) {
  const { app, diagnostics } = input;
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
}
