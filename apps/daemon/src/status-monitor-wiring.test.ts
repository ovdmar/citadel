import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteStore } from "@citadel/db";
import { agentExitSentinelPath, agentLiveSentinelPath } from "@citadel/terminal";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildStatusMonitorDeps } from "./status-monitor-wiring.js";

describe("status-monitor wiring — stale-.exit guard", () => {
  let tmpDbDir: string;
  let store: SqliteStore;
  const sessionNames: string[] = [];

  beforeEach(() => {
    tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-wiring-test-"));
    store = new SqliteStore(path.join(tmpDbDir, "test.sqlite"));
    sessionNames.length = 0;
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    for (const name of sessionNames) {
      try {
        fs.unlinkSync(agentLiveSentinelPath(name));
      } catch {
        // best-effort
      }
      try {
        fs.unlinkSync(agentExitSentinelPath(name));
      } catch {
        // best-effort
      }
    }
  });

  function uniqueName(suffix: string): string {
    const n = `citadel_wiring_test_${process.pid}_${Date.now().toString(36)}_${suffix}`;
    sessionNames.push(n);
    return n;
  }

  it("treats .exit as authoritative when .live is absent (normal exited path)", async () => {
    const name = uniqueName("exited");
    fs.writeFileSync(agentExitSentinelPath(name), "0\n");
    const deps = buildStatusMonitorDeps(store, () => {});
    const reading = await deps.readSentinels(name);
    expect(reading.live).toBe(false);
    expect(reading.exitCode).toBe(0);
    expect(reading.exitedAt).not.toBeNull();
  });

  it("ignores .exit when .live is newer (stale .exit from a prior incarnation)", async () => {
    const name = uniqueName("stale");
    // Write .exit first, then .live ~30ms later so live.mtime > exit.mtime.
    fs.writeFileSync(agentExitSentinelPath(name), "42\n");
    await new Promise((resolve) => setTimeout(resolve, 30));
    fs.writeFileSync(agentLiveSentinelPath(name), "");
    const deps = buildStatusMonitorDeps(store, () => {});
    const reading = await deps.readSentinels(name);
    expect(reading.live).toBe(true);
    expect(reading.exitCode).toBeNull();
    expect(reading.exitedAt).toBeNull();
  });

  it("honors .exit when it is newer than .live (happy path where rm of .live raced)", async () => {
    const name = uniqueName("normal-order");
    // .live first, then .exit later — what a clean exit looks like if the
    // wrapper somehow didn't get to remove .live (defense-in-depth case).
    fs.writeFileSync(agentLiveSentinelPath(name), "");
    await new Promise((resolve) => setTimeout(resolve, 30));
    fs.writeFileSync(agentExitSentinelPath(name), "0\n");
    const deps = buildStatusMonitorDeps(store, () => {});
    const reading = await deps.readSentinels(name);
    expect(reading.live).toBe(true);
    expect(reading.exitCode).toBe(0);
    expect(reading.exitedAt).not.toBeNull();
  });
});
