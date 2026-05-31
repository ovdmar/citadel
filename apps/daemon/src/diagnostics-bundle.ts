// Helpers that turn the daemon's diagnostics surface into something a user
// can email over. Two artefacts:
//   - buildDiagnosticsSnapshot(): JSON object captured at the moment of the
//     request. The ring buffer + a structured view of "what the daemon
//     thinks the world looks like right now" (sessions/workspaces/ttyd
//     inventory/live tmux session names + general process info).
//   - streamDiagnosticsBundle(): tar.gz stream containing the JSONL log
//     files (current + rotated), the same snapshot as a separate file,
//     and a slice of the systemd-journal for the citadel.service unit
//     (best-effort — silently omitted when journalctl is unavailable).
//
// Uses the system `tar` CLI rather than npm `tar` so we don't add a new
// dependency for what is ultimately one tar+gzip on a tiny payload.

import { execFile, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { CitadelConfig } from "@citadel/config";
import type { SqliteStore } from "@citadel/db";
import type { DiagnosticEvent, DiagnosticsLogger } from "@citadel/operations";
import { type TtydManager, listAllTmuxSessions } from "@citadel/terminal";

const execFileAsync = promisify(execFile);

export type DiagnosticsSnapshotDeps = {
  store: SqliteStore;
  ttyd: TtydManager;
  diagnostics: DiagnosticsLogger;
  config: CitadelConfig;
};

export type DiagnosticsSnapshot = {
  capturedAt: string;
  daemon: {
    pid: number;
    nodeVersion: string;
    uptimeSeconds: number;
    rssMb: number;
    port: number;
    dataDir: string;
    worktree: boolean;
    tmuxSocket: string | null;
  };
  ttydInventory: ReturnType<TtydManager["list"]>;
  tmuxLiveSessions: string[] | null;
  sessions: Array<{
    id: string;
    kind: "agent" | "terminal";
    workspaceId: string;
    tabId: string | null;
    status: string;
    statusReason: string | null;
    tmuxSessionName: string | null;
    lastStatusAt: string | null;
    runtimeId: string | null;
  }>;
  workspaces: Array<{ id: string; name: string; path: string; archivedAt: string | null }>;
  recentEvents: DiagnosticEvent[];
  logFile: { path: string | null; sizeBytes: number | null };
  rotatedFile: { path: string | null; sizeBytes: number | null };
};

export function buildDiagnosticsSnapshot(deps: DiagnosticsSnapshotDeps): DiagnosticsSnapshot {
  const logFilePath = deps.diagnostics.filePath();
  const rotatedPath = deps.diagnostics.rotatedPath();
  return {
    capturedAt: new Date().toISOString(),
    daemon: {
      pid: process.pid,
      nodeVersion: process.versions.node,
      uptimeSeconds: Math.round(process.uptime()),
      rssMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
      port: deps.config.port,
      dataDir: deps.config.dataDir,
      worktree: process.env.CITADEL_WORKTREE === "1",
      tmuxSocket: process.env.CITADEL_TMUX_SOCKET ?? null,
    },
    ttydInventory: deps.ttyd.list(),
    tmuxLiveSessions: (() => {
      const set = listAllTmuxSessions();
      return set === null ? null : Array.from(set).sort();
    })(),
    sessions: deps.store.listWorkspaceSessions().map((s) => ({
      id: s.id,
      kind: s.kind,
      workspaceId: s.workspaceId,
      tabId: s.tabId ?? null,
      status: s.status,
      statusReason: s.statusReason ?? null,
      tmuxSessionName: s.tmuxSessionName ?? null,
      lastStatusAt: s.lastStatusAt ?? null,
      runtimeId: s.runtimeId,
    })),
    workspaces: deps.store.listWorkspaces().map((w) => ({
      id: w.id,
      name: w.name,
      path: w.path,
      archivedAt: w.archivedAt ?? null,
    })),
    recentEvents: deps.diagnostics.recent(),
    logFile: { path: logFilePath, sizeBytes: safeSize(logFilePath) },
    rotatedFile: { path: rotatedPath, sizeBytes: safeSize(rotatedPath) },
  };
}

function safeSize(p: string | null): number | null {
  if (!p) return null;
  try {
    return statSync(p).size;
  } catch {
    return null;
  }
}

export async function streamDiagnosticsBundle(
  res: NodeJS.WritableStream & {
    setHeader: (n: string, v: string) => void;
    status?: (code: number) => unknown;
    end?: () => unknown;
  },
  deps: DiagnosticsSnapshotDeps,
): Promise<void> {
  const snapshot = buildDiagnosticsSnapshot(deps);
  const tmpDir = await prepareTmpDir(deps);
  const stageDir = path.join(tmpDir, "citadel-diagnostics");
  await fsp.mkdir(stageDir, { recursive: true });

  try {
    // Snapshot — write once, include in the tar.
    await fsp.writeFile(path.join(stageDir, "snapshot.json"), `${JSON.stringify(snapshot, null, 2)}\n`);

    // systemd journal slice for the citadel.service unit (best-effort —
    // when journalctl is unavailable we still ship a placeholder file so the
    // recipient sees we tried).
    try {
      const out = await execFileAsync(
        "journalctl",
        ["--user-unit", "citadel.service", "--since", "30 minutes ago", "--no-pager"],
        { maxBuffer: 8 * 1024 * 1024 },
      );
      await fsp.writeFile(path.join(stageDir, "citadel-journal.txt"), out.stdout);
    } catch (err) {
      await fsp.writeFile(
        path.join(stageDir, "citadel-journal.txt"),
        `journalctl unavailable: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }

    // Copy the JSONL files (current + rotated, if present) into the stage.
    // Paths are resolved at bundling time so a rotation that happens during
    // the bundle doesn't strand the result.
    if (snapshot.logFile.path && existsSync(snapshot.logFile.path)) {
      await fsp.copyFile(snapshot.logFile.path, path.join(stageDir, path.basename(snapshot.logFile.path)));
    }
    if (snapshot.rotatedFile.path && existsSync(snapshot.rotatedFile.path)) {
      await fsp.copyFile(snapshot.rotatedFile.path, path.join(stageDir, path.basename(snapshot.rotatedFile.path)));
    }

    res.setHeader("Content-Type", "application/gzip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="citadel-diagnostics-${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz"`,
    );

    // `tar -C <parent> -czf - citadel-diagnostics/` produces a deterministic
    // archive whose first path component is `citadel-diagnostics/`. We pipe
    // stdout into the response and wait on the child to finish before
    // returning so the caller can clean up the staging dir.
    await new Promise<void>((resolve, reject) => {
      const child = spawn("tar", ["-C", tmpDir, "-czf", "-", "citadel-diagnostics"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.pipe(res, { end: false });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`tar exited with code ${code}`));
      });
    });
    // Signal end-of-stream on the response so the client unblocks.
    try {
      (res as { end?: () => unknown }).end?.();
    } catch {
      /* ignore */
    }
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {
      /* ignore */
    });
  }
}

async function prepareTmpDir(deps: DiagnosticsSnapshotDeps): Promise<string> {
  const base = path.join(deps.config.dataDir, "diagnostics-bundles");
  const tmpDir = path.join(base, `${process.pid}-${Date.now()}`);
  await fsp.mkdir(tmpDir, { recursive: true });
  return tmpDir;
}
