import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { closeServer, createFixture as createFixtureBase, getJson, listen } from "./app-test-helpers.js";
import { createDaemonApp } from "./app.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("diagnostics client events", () => {
  it("records top-level browser lifecycle events", async () => {
    const fixture = createFixtureBase(dirs);
    const { server } = await createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const response = await fetch(`${baseUrl}/api/diagnostics/client-event`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "vitest" },
        body: JSON.stringify({
          event: "page.pagehide",
          pageId: "page_1",
          path: "/",
          href: "http://127.0.0.1/",
          visibility: "hidden",
          focused: false,
          navigationType: "reload",
          ageMs: 123,
          persisted: false,
          online: true,
          wasDiscarded: false,
          swController: true,
        }),
      });
      expect(response.status).toBe(204);

      const snapshot = await getJson<{
        recentEvents: Array<{ category: string; event: string; data?: Record<string, unknown> }>;
      }>(`${baseUrl}/api/diagnostics/snapshot`);
      expect(snapshot.recentEvents).toContainEqual(
        expect.objectContaining({
          category: "ui-client",
          event: "page.pagehide",
          data: expect.objectContaining({
            pageId: "page_1",
            navigationType: "reload",
            focused: false,
            persisted: false,
            swController: true,
          }),
        }),
      );
    } finally {
      await closeServer(server);
    }
  });
});
