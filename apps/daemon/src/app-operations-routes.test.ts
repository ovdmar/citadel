import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { closeServer, createFixture as createFixtureBase, listen } from "./app-test-helpers.js";
import { createDaemonApp } from "./app.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

process.env.CITADEL_DISABLE_REAPER = "1";
process.env.CITADEL_DISABLE_SCHEDULER = "1";
process.env.CITADEL_DISABLE_TERMINAL_REAPER = "1";

describe("operation routes", () => {
  it("operation cancel and retry endpoints return 202 / 409 appropriately", async () => {
    const fixture = createFixtureBase(dirs);
    const { server } = await createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      fixture.store.upsertOperation({
        id: "op_fake_running",
        type: "workspace.action.custom",
        status: "running",
        repoId: null,
        workspaceId: null,
        progress: 5,
        message: "Doing things",
        error: null,
        logs: [],
        retriable: false,
        retryInput: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      const cancel = await fetch(`${baseUrl}/api/operations/op_fake_running/cancel`, { method: "POST" });
      expect(cancel.status).toBe(202);
      const after = (await fetch(`${baseUrl}/api/operations/op_fake_running`).then((r) => r.json())) as {
        operation: { status: string };
      };
      expect(after.operation.status).toBe("cancelled");
      const retry = await fetch(`${baseUrl}/api/operations/op_fake_running/retry`, { method: "POST" });
      expect(retry.status).toBe(409);
    } finally {
      await closeServer(server);
    }
  });
});
