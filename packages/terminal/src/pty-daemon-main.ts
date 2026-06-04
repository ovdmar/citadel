import { PtyDaemonServer } from "./pty-daemon-server.js";

const socketPath = process.env.CITADEL_PTY_DAEMON_SOCKET;

if (!socketPath) {
  console.error("CITADEL_PTY_DAEMON_SOCKET is required");
  process.exit(1);
}

const server = new PtyDaemonServer({ socketPath });

await server.start();
console.error(`[citadel-pty-daemon] listening on ${socketPath}`);

const shutdown = async () => {
  await server.close();
  process.exit(0);
};

process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});
