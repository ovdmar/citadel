import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function defaultCitadelDataDir(): string {
  return process.env.CITADEL_DATA_DIR || path.join(os.homedir(), ".local", "share", "citadel");
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, "_") || "unknown";
}

export function codexSqliteHomeForWorkspace(workspaceId: string, dataDir: string = defaultCitadelDataDir()): string {
  return path.join(path.resolve(dataDir), "codex-sqlite", safeSegment(workspaceId));
}

export function prepareCodexSqliteHomeForWorkspace(input: { workspaceId: string; dataDir?: string }): string {
  const sqliteHome = codexSqliteHomeForWorkspace(input.workspaceId, input.dataDir);
  fs.mkdirSync(sqliteHome, { recursive: true, mode: 0o700 });
  return sqliteHome;
}
