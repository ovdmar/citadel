import fs from "node:fs";
import { afterEach, expect, it } from "vitest";
import { closeServer, createFixture as createFixtureBase, listen } from "./app-test-helpers.js";
import { createDaemonApp } from "./app.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

process.env.CITADEL_DISABLE_REAPER = "1";
process.env.CITADEL_DISABLE_SCHEDULER = "1";
process.env.CITADEL_DISABLE_TERMINAL_REAPER = "1";

it("rejects Playwright e2e-marked traffic unless the run id matches", async () => {
  const previous = process.env.CITADEL_E2E_RUN_ID;
  try {
    Reflect.deleteProperty(process.env, "CITADEL_E2E_RUN_ID");
    const prod = createDaemonApp(createFixtureBase(dirs));
    const prodBaseUrl = await listen(prod.server);
    try {
      const response = await fetch(`${prodBaseUrl}/api/health`, {
        headers: { Connection: "close", "X-Citadel-E2E-Run-Id": "run-a" },
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: "e2e_run_id_mismatch" });
    } finally {
      await closeServer(prod.server);
    }

    process.env.CITADEL_E2E_RUN_ID = "run-a";
    const e2eFixture = createFixtureBase(dirs);
    const e2e = createDaemonApp(e2eFixture);
    const e2eBaseUrl = await listen(e2e.server);
    try {
      const wrongRun = await fetch(`${e2eBaseUrl}/api/health`, {
        headers: { Connection: "close", "X-Citadel-E2E-Run-Id": "run-b" },
      });
      expect(wrongRun.status).toBe(409);

      const ok = await fetch(`${e2eBaseUrl}/api/health`, {
        headers: { Connection: "close", "X-Citadel-E2E-Run-Id": "run-a" },
      });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({
        e2e: { enabled: true, runId: "run-a", dataDir: e2eFixture.config.dataDir },
      });
    } finally {
      await closeServer(e2e.server);
    }
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, "CITADEL_E2E_RUN_ID");
    else process.env.CITADEL_E2E_RUN_ID = previous;
  }
}, 20_000);
