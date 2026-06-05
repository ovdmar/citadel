import { type PtyDaemonHandoffMessage, clearHandoffSnapshot, readHandoffSnapshot } from "./pty-daemon-handoff.js";
import { PtyDaemonServer } from "./pty-daemon-server.js";

if (process.argv.includes("--handoff")) {
  await runHandoffReceiver();
} else {
  await runFresh();
}

async function runFresh(): Promise<void> {
  const socketPath = socketPathFromArgs() ?? process.env.CITADEL_PTY_DAEMON_SOCKET;
  if (!socketPath) {
    console.error("CITADEL_PTY_DAEMON_SOCKET or --socket=PATH is required");
    process.exit(1);
  }

  const server = new PtyDaemonServer({ socketPath });

  await server.start();
  console.error(`[citadel-pty-daemon] listening on ${socketPath}`);
  wireShutdown(server);
}

async function runHandoffReceiver(): Promise<void> {
  const socketPath = socketPathFromArgs();
  const snapshotPath = snapshotPathFromArgs();
  if (!socketPath) throw new Error("--socket=PATH is required for handoff");
  if (!snapshotPath) throw new Error("--snapshot=PATH is required for handoff");
  if (typeof process.send !== "function") throw new Error("handoff receiver requires an IPC channel");

  const server = new PtyDaemonServer({ socketPath });
  try {
    server.adoptSnapshot(readHandoffSnapshot(snapshotPath));
  } catch (error) {
    process.send({
      type: "upgrade-nak",
      reason: error instanceof Error ? error.message : "handoff adoption failed",
    } satisfies PtyDaemonHandoffMessage);
    setTimeout(() => process.exit(1), 50).unref();
    return;
  }

  process.send({ type: "upgrade-ack", successorPid: process.pid } satisfies PtyDaemonHandoffMessage);

  await new Promise<void>((resolve) => {
    if (process.connected !== true) {
      resolve();
      return;
    }
    process.once("disconnect", () => resolve());
    setTimeout(() => resolve(), 1000).unref();
  });

  await server.startWithRetry();
  clearHandoffSnapshot(snapshotPath);
  console.error(`[citadel-pty-daemon] handoff successor listening on ${socketPath}`);
  wireShutdown(server);
}

function wireShutdown(server: PtyDaemonServer): void {
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await server.close();
    process.exit(0);
  };

  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });
}

function socketPathFromArgs(): string | undefined {
  return argValue("--socket=");
}

function snapshotPathFromArgs(): string | undefined {
  return argValue("--snapshot=");
}

function argValue(prefix: string): string | undefined {
  const value = process.argv.find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length) : undefined;
}
