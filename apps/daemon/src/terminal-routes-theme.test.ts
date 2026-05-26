import fs from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { AgentSession, Workspace } from "@citadel/contracts";
import type { SqliteStore } from "@citadel/db";
import type { TtydEntry, TtydManager } from "@citadel/terminal";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThemePrefStore, parseTheme, registerTerminalRoutes } from "./terminal-routes.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-theme-test-"));
  tempDirs.push(dir);
  return dir;
}

describe("parseTheme", () => {
  it("returns the value for 'light' and 'dark'", () => {
    expect(parseTheme("light")).toBe("light");
    expect(parseTheme("dark")).toBe("dark");
  });

  it("returns undefined for empty / null / undefined without logging", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseTheme(undefined)).toBeUndefined();
    expect(parseTheme(null)).toBeUndefined();
    expect(parseTheme("")).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("returns undefined AND logs a warning for unrecognized values (e.g. 'system')", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseTheme("system")).toBeUndefined();
    expect(parseTheme("midnight")).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]?.[0]).toContain("system");
    expect(warn.mock.calls[1]?.[0]).toContain("midnight");
  });
});

describe("ThemePrefStore", () => {
  it("persists theme to disk and round-trips on reload", () => {
    const dir = mkTmp();
    const a = new ThemePrefStore(dir);
    a.set("session-1", "light");
    a.set("session-2", "dark");

    const file = path.join(dir, "terminal-theme-prefs.json");
    expect(fs.existsSync(file)).toBe(true);

    const b = new ThemePrefStore(dir);
    expect(b.get("session-1")).toBe("light");
    expect(b.get("session-2")).toBe("dark");
  });

  it("returns undefined for unknown sessions", () => {
    const store = new ThemePrefStore(mkTmp());
    expect(store.get("never-set")).toBeUndefined();
  });

  it("ignores corrupt sidecar JSON without crashing", () => {
    const dir = mkTmp();
    fs.writeFileSync(path.join(dir, "terminal-theme-prefs.json"), "{not json");
    const store = new ThemePrefStore(dir);
    expect(store.get("anything")).toBeUndefined();
    // The next set() should still work and overwrite the file cleanly.
    store.set("session-1", "light");
    expect(new ThemePrefStore(dir).get("session-1")).toBe("light");
  });

  it("filters out non-theme values during load (defends against manual file edits)", () => {
    const dir = mkTmp();
    fs.writeFileSync(
      path.join(dir, "terminal-theme-prefs.json"),
      JSON.stringify({ a: "light", b: "system", c: 42, d: "dark" }),
    );
    // The constructor calls parseTheme internally; "system" + 42 trigger the
    // unrecognized-value warning path. Suppress so it doesn't pollute output.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new ThemePrefStore(dir);
    expect(store.get("a")).toBe("light");
    expect(store.get("b")).toBeUndefined();
    expect(store.get("c")).toBeUndefined();
    expect(store.get("d")).toBe("dark");
    expect(warn).toHaveBeenCalled();
  });
});

// Integration tests for the boundary `resolveTheme` precedence:
//
//   request.query.theme  >  ThemePrefStore.get(sessionId)  >  "dark" + warn
//
// These tests stub the TtydManager so we never spawn real ttyd, and stub the
// SqliteStore so we don't touch the real DB. They cover the gap the unit
// tests of parseTheme + ThemePrefStore alone leave: the actual end-to-end
// route handler that the cockpit talks to.

function makeFakeStore(session: AgentSession, workspace: Workspace): SqliteStore {
  // Cast through unknown: we only need the two methods the route uses.
  return {
    listSessions: () => [session],
    listWorkspaces: () => [workspace],
  } as unknown as SqliteStore;
}

type SpawnCall = { key: string; theme: string; force?: boolean };

function makeFakeTtyd(spawnCalls: SpawnCall[]): TtydManager {
  return {
    ensure(args: Parameters<TtydManager["ensure"]>[0]) {
      const call: SpawnCall = { key: args.key, theme: args.theme };
      if (args.force !== undefined) call.force = args.force;
      spawnCalls.push(call);
      const entry: TtydEntry = {
        key: args.key,
        port: 7799,
        pid: 99,
        basePath: `/terminals/${args.key}`,
        tmuxSession: args.tmuxSession,
        worktreePath: args.worktreePath ?? null,
        startedAt: new Date().toISOString(),
        theme: args.theme,
      };
      return Promise.resolve(entry);
    },
    lookup: () => null,
    release: () => {},
    list: () => [],
    cleanupStale: () => ({ killed: 0, portRange: [7721, 7740] }),
    shutdown: () => {},
    config: {
      ttydBin: "/bin/true",
      shellBin: "/bin/bash",
      portBase: 7721,
      portMax: 7740,
      basePathPrefix: "terminals",
      readyTimeoutMs: 1000,
      publicPath: () => "/terminals/",
    },
  } as unknown as TtydManager;
}

const SESSION: AgentSession = {
  id: "sess-1",
  workspaceId: "ws-1",
  runtimeId: "shell",
  displayName: "Test",
  status: "running",
  statusReason: null,
  lastStatusAt: "2026-05-25T12:00:00.000Z",
  lastOutputAt: null,
  endedAt: null,
  exitCode: null,
  transport: "disconnected",
  tmuxSessionName: "citadel_sess_1",
  tmuxSessionId: "$1",
  createdAt: "2026-05-25T12:00:00.000Z",
  updatedAt: "2026-05-25T12:00:00.000Z",
} as AgentSession;

const WORKSPACE: Workspace = {
  id: "ws-1",
  repoId: "repo-1",
  name: "test",
  branch: "main",
  path: "/tmp/ws-1",
  kind: "feature",
  status: "ready",
  archived: false,
} as unknown as Workspace;

async function withRoute(dataDir: string, fn: (args: { baseUrl: string; spawnCalls: SpawnCall[] }) => Promise<void>) {
  const spawnCalls: SpawnCall[] = [];
  const app = express();
  app.use(express.json());
  const server = createServer(app) as Server;
  registerTerminalRoutes({
    app,
    server,
    store: makeFakeStore(SESSION, WORKSPACE),
    ttyd: makeFakeTtyd(spawnCalls),
    dataDir,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await fn({ baseUrl, spawnCalls });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("terminal route resolveTheme precedence (integration)", () => {
  it("uses ?theme= from the request when explicitly provided", async () => {
    const dir = mkTmp();
    await withRoute(dir, async ({ baseUrl, spawnCalls }) => {
      const res = await fetch(`${baseUrl}/api/agent-sessions/sess-1/terminal?theme=light`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      expect(spawnCalls).toHaveLength(1);
      expect(spawnCalls[0]?.theme).toBe("light");
    });
  });

  it("falls back to ThemePrefStore when ?theme= is absent and persists each request's theme", async () => {
    const dir = mkTmp();
    // Seed the store from a prior session.
    new ThemePrefStore(dir).set("sess-1", "light");
    await withRoute(dir, async ({ baseUrl, spawnCalls }) => {
      const res = await fetch(`${baseUrl}/api/agent-sessions/sess-1/terminal`, { method: "POST" });
      expect(res.status).toBe(200);
      expect(spawnCalls[0]?.theme).toBe("light");
    });
  });

  it("falls back to 'dark' AND emits a console.warn when neither query nor store provide a theme", async () => {
    const dir = mkTmp();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await withRoute(dir, async ({ baseUrl, spawnCalls }) => {
      const res = await fetch(`${baseUrl}/api/agent-sessions/sess-1/terminal`, { method: "POST" });
      expect(res.status).toBe(200);
      expect(spawnCalls[0]?.theme).toBe("dark");
      expect(warn).toHaveBeenCalled();
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/no theme available/);
    });
  });

  it("explicit ?theme= overrides a stored value (request wins over store)", async () => {
    const dir = mkTmp();
    new ThemePrefStore(dir).set("sess-1", "light");
    await withRoute(dir, async ({ baseUrl, spawnCalls }) => {
      const res = await fetch(`${baseUrl}/api/agent-sessions/sess-1/terminal?theme=dark`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      expect(spawnCalls[0]?.theme).toBe("dark");
    });
  });

  it("unrecognized ?theme=system falls through to the store (and warns about the unrecognized value)", async () => {
    const dir = mkTmp();
    new ThemePrefStore(dir).set("sess-1", "light");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await withRoute(dir, async ({ baseUrl, spawnCalls }) => {
      const res = await fetch(`${baseUrl}/api/agent-sessions/sess-1/terminal?theme=system`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      expect(spawnCalls[0]?.theme).toBe("light");
      // parseTheme should have warned about the unrecognized "system" value.
      expect(warn.mock.calls.some((call) => String(call[0]).includes("unrecognized"))).toBe(true);
    });
  });

  it("force=true is propagated to ensure() alongside the resolved theme", async () => {
    const dir = mkTmp();
    await withRoute(dir, async ({ baseUrl, spawnCalls }) => {
      const res = await fetch(`${baseUrl}/api/agent-sessions/sess-1/terminal?theme=dark&force=true`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      expect(spawnCalls[0]?.force).toBe(true);
      expect(spawnCalls[0]?.theme).toBe("dark");
    });
  });
});
