import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { QUICK_CAPTURE_SILENCE_TIMEOUT_MS, registerQuickCaptureRoute } from "./quick-capture-route.js";
import { registerSpaFallback } from "./spa-fallback-route.js";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
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

  it("templates the silence timeout from QUICK_CAPTURE_SILENCE_TIMEOUT_MS into the inline JS", async () => {
    const baseUrl = await startApp();
    const body = await (await fetch(`${baseUrl}/quick-capture`)).text();
    expect(body).toContain(
      `setTimeout(function(){ if (rec) try { rec.stop(); } catch(_){} }, ${QUICK_CAPTURE_SILENCE_TIMEOUT_MS})`,
    );
    expect(body).not.toContain("__SILENCE_TIMEOUT_MS__");
  });
});

// Integration: /quick-capture must win over the SPA fallback when both
// routes are registered in the same order as apps/daemon/src/app.ts. A
// regression that swaps the order would have the wildcard SPA route swallow
// /quick-capture and serve the cockpit index.html — this test catches that.
describe("/quick-capture + SPA fallback ordering", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  async function start(quickCaptureFirst: boolean): Promise<string> {
    const webDist = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-qc-order-"));
    tmpDirs.push(webDist);
    fs.writeFileSync(path.join(webDist, "index.html"), "<!doctype html><title>cockpit-shell</title>");
    const app = express();
    if (quickCaptureFirst) {
      registerQuickCaptureRoute({ app });
      registerSpaFallback({ app, webDist });
    } else {
      registerSpaFallback({ app, webDist });
      registerQuickCaptureRoute({ app });
    }
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

  it("correct order: GET /quick-capture returns the quick-capture HTML (not the SPA shell)", async () => {
    const baseUrl = await start(true);
    const body = await (await fetch(`${baseUrl}/quick-capture`)).text();
    expect(body).toContain("<textarea");
    expect(body).toContain("/api/scratchpad/blocks");
    expect(body).not.toContain("cockpit-shell");
  });

  it("regression demonstration: SPA-first order WOULD serve the cockpit shell (this is why ordering matters)", async () => {
    const baseUrl = await start(false);
    const body = await (await fetch(`${baseUrl}/quick-capture`)).text();
    // With the wrong order, the wildcard returns the cockpit shell. This test
    // documents the failure mode the correct-order test guards against.
    expect(body).toContain("cockpit-shell");
  });
});
