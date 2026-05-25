import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { registerSpaFallback } from "./spa-fallback-route.js";

const dirs: string[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
    ),
  );
});

function makeWebDist(withIndex: boolean) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-spa-fallback-"));
  dirs.push(dir);
  if (withIndex) fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>cockpit</title>");
  return dir;
}

function startApp(register: (app: express.Express) => void) {
  const app = express();
  register(app);
  // Final JSON error handler mirroring app.ts so a non-matched /api/* request
  // surfaces as JSON 404, not as the SPA shell. The fallback must hand off via
  // `next()` so this handler runs.
  app.use((_req, res) => res.status(404).json({ error: "not_found" }));
  const server = http.createServer(app);
  servers.push(server);
  return new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected TCP address");
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

describe("registerSpaFallback", () => {
  it("serves the SPA shell as HTML for an arbitrary non-API GET when index.html exists", async () => {
    const webDist = makeWebDist(true);
    const baseUrl = await startApp((app) => registerSpaFallback({ app, webDist }));
    const response = await fetch(`${baseUrl}/some/cockpit/path`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/text\/html/);
    const body = await response.text();
    expect(body).toContain("cockpit");
  });

  it("falls through (does NOT return SPA shell) for /api/* so the JSON 404 handler runs", async () => {
    const webDist = makeWebDist(true);
    const baseUrl = await startApp((app) => registerSpaFallback({ app, webDist }));
    const response = await fetch(`${baseUrl}/api/unknown`);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toMatch(/application\/json/);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("not_found");
  });

  it("falls through for the /events SSE path", async () => {
    const webDist = makeWebDist(true);
    const baseUrl = await startApp((app) => registerSpaFallback({ app, webDist }));
    const response = await fetch(`${baseUrl}/events`);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("not_found");
  });

  it("registers no routes when index.html is absent", async () => {
    const webDist = makeWebDist(false);
    const baseUrl = await startApp((app) => registerSpaFallback({ app, webDist }));
    const response = await fetch(`${baseUrl}/any/path`);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("not_found");
  });
});
