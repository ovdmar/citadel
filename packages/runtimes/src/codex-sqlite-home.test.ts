import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codexSqliteHomeForWorkspace, prepareCodexSqliteHomeForWorkspace } from "./codex-sqlite-home.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("codex sqlite homes", () => {
  it("creates an isolated SQLite state directory for a workspace", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-codex-sqlite-"));
    dirs.push(dir);

    const sqliteHome = prepareCodexSqliteHomeForWorkspace({
      workspaceId: "ws/test:one",
      dataDir: dir,
    });

    expect(sqliteHome).toBe(codexSqliteHomeForWorkspace("ws/test:one", dir));
    expect(sqliteHome).toBe(path.join(dir, "codex-sqlite", "ws_test_one"));
    expect(fs.statSync(sqliteHome).isDirectory()).toBe(true);
  });

  it("resolves relative data dirs before handing the path to Codex", () => {
    expect(codexSqliteHomeForWorkspace("ws_1", "relative-citadel-data")).toBe(
      path.resolve("relative-citadel-data", "codex-sqlite", "ws_1"),
    );
  });
});
