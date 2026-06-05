import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CitadelConfig } from "@citadel/config";
import { SqliteStore } from "@citadel/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_STATUS_MONITOR_INTERVAL_MS,
  buildStatusMonitorDeps,
  shouldReusePaneCaptureCache,
} from "./status-monitor-wiring.js";

// Shell-first wiring smoke tests. The legacy readSentinels stale-.exit guard
// is gone (the wrapper that wrote those files is removed). The replacement
// is panePidProcess + runtimeBinaryFor — both stateless lookups, validated
// here only at the wiring-shape level. End-to-end behavior is covered by
// packages/operations/src/status-monitor.test.ts.

describe("buildStatusMonitorDeps — shell-first wiring", () => {
  let tmpDbDir: string;
  let store: SqliteStore;

  beforeEach(() => {
    tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-wiring-test-"));
    store = new SqliteStore(path.join(tmpDbDir, "test.sqlite"));
    store.migrate();
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDbDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  function makeConfig(agentRuntimes: Array<{ id: string; command: string }>): CitadelConfig {
    return {
      version: 1,
      dataDir: tmpDbDir,
      databasePath: path.join(tmpDbDir, "test.sqlite"),
      bindHost: "127.0.0.1",
      port: 4010,
      mcp: { enabled: false },
      providers: {
        github: { enabled: false, command: "gh" },
        jira: { enabled: false, command: "jtk", autoTransitions: [] },
      },
      agentRuntimes: agentRuntimes.map((r) => ({ ...r, args: [], displayName: r.id })),
      terminal: { displayName: "Terminal", command: "bash", args: ["-l"] },
    } as unknown as CitadelConfig;
  }

  it("uses a 2s default status-monitor cadence", () => {
    expect(DEFAULT_STATUS_MONITOR_INTERVAL_MS).toBe(2000);
  });

  it("exposes panePidProcess that returns null for a missing tmux session (the tmux_missing signal)", () => {
    const recent = new Map<string, number>();
    const deps = buildStatusMonitorDeps(store, () => {}, makeConfig([]), recent);
    expect(deps.panePidProcess("citadel_does_not_exist_xyz")).toBeNull();
  });

  it("exposes runtimeBinaryFor that maps configured runtimes to their command names", () => {
    const recent = new Map<string, number>();
    const deps = buildStatusMonitorDeps(
      store,
      () => {},
      makeConfig([
        { id: "claude-code", command: "claude" },
        { id: "codex", command: "codex" },
        { id: "bash-debug", command: "bash" },
      ]),
      recent,
    );
    expect(deps.runtimeBinaryFor("claude-code")).toBe("claude");
    expect(deps.runtimeBinaryFor("codex")).toBe("codex");
    expect(deps.runtimeBinaryFor("bash-debug")).toBe("bash");
    expect(deps.runtimeBinaryFor("unknown-runtime")).toBeNull();
  });

  it("threads the recentUserAction map by reference so writes from endpoints land in the status-monitor's tick", () => {
    const recent = new Map<string, number>();
    const deps = buildStatusMonitorDeps(store, () => {}, makeConfig([]), recent);
    recent.set("sess_x", 12345);
    // The deps holds the SAME Map reference, so the status-monitor will see
    // the write on its next tick.
    expect(deps.recentUserAction.get("sess_x")).toBe(12345);
  });

  it("reuses pane captures only while activity and max-age agree", () => {
    const cached = { activityMs: 1000, capturedAtMs: 10_000, content: "old pane" };

    expect(shouldReusePaneCaptureCache(cached, 1000, 15_000)).toBe(true);
    expect(shouldReusePaneCaptureCache(cached, 1000, 21_000)).toBe(false);
    expect(shouldReusePaneCaptureCache(cached, 2000, 15_000)).toBe(false);
    expect(shouldReusePaneCaptureCache(cached, 1000, 10_500, { maxAgeMs: 250 })).toBe(false);
    expect(shouldReusePaneCaptureCache(cached, 1000, 10_100, { force: true })).toBe(false);
  });
});
