import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectPtyDaemonClient } from "@citadel/terminal";

export type PtyDaemonOwner = {
  socketPath: string;
  pid: number | null;
  adopted: boolean;
};

export function ptyDaemonSocketPath(dataDir: string): string {
  return path.join(dataDir, "run", "pty-daemon.sock");
}

export async function ensurePtyDaemon(input: {
  dataDir: string;
  socketPath?: string;
  timeoutMs?: number;
}): Promise<PtyDaemonOwner> {
  const socketPath = input.socketPath ?? ptyDaemonSocketPath(input.dataDir);
  if (await canConnect(socketPath, 250)) return { socketPath, pid: null, adopted: true };

  await fs.promises.mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  await chmodBestEffort(path.dirname(socketPath), 0o700);

  const entry = resolvePtyDaemonEntry();
  const child = spawn(entry.command, entry.args, {
    cwd: repoRoot(),
    detached: true,
    env: {
      ...process.env,
      CITADEL_PTY_DAEMON_SOCKET: socketPath,
    },
    stdio: "ignore",
  });
  child.unref();

  await waitForPtyDaemon(socketPath, input.timeoutMs ?? 3000);
  return { socketPath, pid: child.pid ?? null, adopted: false };
}

async function waitForPtyDaemon(socketPath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canConnect(socketPath, 250)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`PTY daemon failed to bind ${socketPath} within ${timeoutMs}ms`);
}

async function canConnect(socketPath: string, timeoutMs: number): Promise<boolean> {
  try {
    const client = await connectPtyDaemonClient({ socketPath, timeoutMs });
    await client.list();
    client.dispose();
    return true;
  } catch {
    return false;
  }
}

function resolvePtyDaemonEntry(): { command: string; args: string[] } {
  const root = repoRoot();
  const distEntry = path.join(root, "packages", "terminal", "dist", "pty-daemon-main.js");
  if (fs.existsSync(distEntry)) return { command: process.execPath, args: [distEntry] };
  return {
    command: "pnpm",
    args: ["exec", "tsx", path.join(root, "packages", "terminal", "src", "pty-daemon-main.ts")],
  };
}

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}

async function chmodBestEffort(target: string, mode: number): Promise<void> {
  try {
    await fs.promises.chmod(target, mode);
  } catch {
    /* Directory permissions are a hardening layer; mkdir already enforces them for new paths. */
  }
}
