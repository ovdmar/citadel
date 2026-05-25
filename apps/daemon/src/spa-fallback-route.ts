import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

// Default web/dist location relative to the compiled daemon entry. Resolved
// here so callers don't have to repeat the import.meta.url dance.
export const DEFAULT_WEB_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");

// Serves the built cockpit SPA shell as the catch-all for non-API GETs so
// TanStack Router can claim any deep path. Extracted from app.ts to keep
// that file under the 800-line gate; behavior is preserved verbatim.
export function registerSpaFallback(input: { app: express.Express; webDist?: string }): void {
  const webDist = input.webDist ?? DEFAULT_WEB_DIST;
  if (!fs.existsSync(path.join(webDist, "index.html"))) return;
  input.app.use(express.static(webDist, { index: false }));
  input.app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/") || req.path === "/events") return next();
    res.sendFile(path.join(webDist, "index.html"));
  });
}
