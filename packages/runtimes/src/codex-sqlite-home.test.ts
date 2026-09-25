import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CODEX_HOME_ROOT,
  codexHomeForWorkspace,
  codexSqliteHomeForWorkspace,
  prepareCodexHomeForWorkspace,
  prepareCodexSqliteHomeForWorkspace,
} from "./codex-sqlite-home.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("codex sqlite homes", () => {
  it("creates isolated Codex state directories for a workspace", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-codex-home-"));
    dirs.push(dir);

    const prepared = prepareCodexHomeForWorkspace({
      workspaceId: "ws/test:one",
      homeRoot: dir,
    });

    expect(prepared.home).toBe(codexHomeForWorkspace("ws/test:one", dir));
    expect(prepared.home).toBe(path.join(dir, "ws_test_one"));
    expect(prepared.sqliteHome).toBe(path.join(dir, "ws_test_one", "sqlite"));
    expect(fs.statSync(prepared.home).isDirectory()).toBe(true);
    expect(fs.statSync(prepared.sqliteHome).isDirectory()).toBe(true);
  });

  it("resolves relative Codex home roots before handing the path to Codex", () => {
    expect(codexSqliteHomeForWorkspace("ws_1", "relative-citadel-data")).toBe(
      path.resolve("relative-citadel-data", "ws_1", "sqlite"),
    );
  });

  it("defaults Codex state to /var/tmp", () => {
    expect(codexHomeForWorkspace("ws_1")).toBe(path.join(DEFAULT_CODEX_HOME_ROOT, "ws_1"));
    expect(codexSqliteHomeForWorkspace("ws_1")).toBe(path.join(DEFAULT_CODEX_HOME_ROOT, "ws_1", "sqlite"));
  });

  it("keeps the SQLite-only helper for compatibility", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-codex-sqlite-"));
    dirs.push(dir);

    const sqliteHome = prepareCodexSqliteHomeForWorkspace({ workspaceId: "ws/test:one", homeRoot: dir });

    expect(sqliteHome).toBe(path.join(dir, "ws_test_one", "sqlite"));
    expect(fs.statSync(sqliteHome).isDirectory()).toBe(true);
  });
});
