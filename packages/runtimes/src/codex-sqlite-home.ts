import fs from "node:fs";
import path from "node:path";

export const DEFAULT_CODEX_HOME_ROOT = "/var/tmp/citadel/codex";

function defaultCodexHomeRoot(): string {
  return process.env.CITADEL_CODEX_HOME_ROOT || DEFAULT_CODEX_HOME_ROOT;
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, "_") || "unknown";
}

export function codexHomeForWorkspace(workspaceId: string, homeRoot: string = defaultCodexHomeRoot()): string {
  return path.join(path.resolve(homeRoot), safeSegment(workspaceId));
}

export function codexSqliteHomeForWorkspace(workspaceId: string, homeRoot: string = defaultCodexHomeRoot()): string {
  return path.join(codexHomeForWorkspace(workspaceId, homeRoot), "sqlite");
}

export function prepareCodexHomeForWorkspace(input: {
  workspaceId: string;
  homeRoot?: string;
}): { home: string; sqliteHome: string } {
  const home = codexHomeForWorkspace(input.workspaceId, input.homeRoot);
  const sqliteHome = codexSqliteHomeForWorkspace(input.workspaceId, input.homeRoot);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(sqliteHome, { recursive: true, mode: 0o700 });
  return { home, sqliteHome };
}

export function prepareCodexSqliteHomeForWorkspace(input: { workspaceId: string; homeRoot?: string }): string {
  const sqliteHome = codexSqliteHomeForWorkspace(input.workspaceId, input.homeRoot);
  fs.mkdirSync(sqliteHome, { recursive: true, mode: 0o700 });
  return sqliteHome;
}
