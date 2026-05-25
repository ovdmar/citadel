import http from "node:http";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { registerQuickCaptureRoute } from "./quick-capture-route.js";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
    ),
  );
});

async function startApp(): Promise<string> {
  const app = express();
  registerQuickCaptureRoute({ app });
  // Mimic the daemon's final 404 so we can probe fall-through behavior.
  app.use((_req, res) => res.status(404).json({ error: "not_found" }));
  const server = http.createServer(app);
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected TCP address");
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

describe("GET /quick-capture", () => {
  it("returns 200 with text/html", async () => {
    const baseUrl = await startApp();
    const response = await fetch(`${baseUrl}/quick-capture`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/text\/html/);
    expect(response.headers.get("content-type")).toMatch(/charset=utf-8/i);
  });

  it("includes a <textarea> and references /api/scratchpad/blocks verbatim", async () => {
    const baseUrl = await startApp();
    const response = await fetch(`${baseUrl}/quick-capture`);
    const body = await response.text();
    expect(body).toMatch(/<textarea\b/);
    expect(body).toContain("/api/scratchpad/blocks");
  });

  it("includes the iOS-Safari close-fallback message string", async () => {
    const baseUrl = await startApp();
    const body = await (await fetch(`${baseUrl}/quick-capture`)).text();
    expect(body).toContain("Press ⌘W to close");
  });

  it("does NOT match a sub-path (regression guard against wildcard registration)", async () => {
    const baseUrl = await startApp();
    const response = await fetch(`${baseUrl}/quick-capture/anything`);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toMatch(/application\/json/);
  });

  it("POST /quick-capture is not the HTML page", async () => {
    const baseUrl = await startApp();
    const response = await fetch(`${baseUrl}/quick-capture`, { method: "POST" });
    // Express returns 404 for an unregistered method+path combination via the
    // final handler — confirms registration was GET-only.
    expect(response.status).toBe(404);
    const ct = response.headers.get("content-type") ?? "";
    expect(ct).not.toMatch(/text\/html/);
  });
});
