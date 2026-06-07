import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { CitadelConfig } from "@citadel/config";
import type { SystemResourceOffenderBreakdown } from "@citadel/contracts";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { asyncRoute } from "./app-helpers.js";
import { closeServer, getJson, listen } from "./app-test-helpers.js";
import { registerSystemHealthRoute } from "./system-health-route.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("system health route", () => {
  it("serves resource offender breakdowns and rejects unknown resource types", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-health-route-"));
    dirs.push(dataDir);
    fs.writeFileSync(path.join(dataDir, "fixture.txt"), "fixture\n");

    const app = express();
    const server = http.createServer(app);
    registerSystemHealthRoute({ app, config: { dataDir } as CitadelConfig, asyncRoute });
    const baseUrl = await listen(server);

    try {
      const body = await getJson<{ breakdown: SystemResourceOffenderBreakdown }>(
        `${baseUrl}/api/system-health/resources/cpu/offenders`,
      );
      expect(body.breakdown).toMatchObject({ resource: "cpu", status: "available" });
      expect(body.breakdown.offenders.length).toBeLessThanOrEqual(5);

      const invalid = await fetch(`${baseUrl}/api/system-health/resources/nope/offenders`);
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toEqual({ error: "invalid_resource_type" });
    } finally {
      await closeServer(server);
    }
  });
});
