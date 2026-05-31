import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CitadelConfig } from "@citadel/config";
import { SqliteStore } from "@citadel/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildStatusMonitorDeps } from "./status-monitor-wiring.js";

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
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
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
        jira: { enabled: false, command: "jtk" },
      },
      agentRuntimes: agentRuntimes.map((r) => ({ ...r, args: [], displayName: r.id })),
      terminal: { displayName: "Terminal", command: "bash", args: ["-l"] },
    } as unknown as CitadelConfig;
  }

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
});
