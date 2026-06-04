import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { attachTerminalWebSocket } from "./index.js";
import { PtyDaemonServer } from "./pty-daemon-server.js";
import { type PtyLike, PtySessionStore } from "./pty-daemon-store.js";

const dirs: string[] = [];
const servers: PtyDaemonServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("PTY daemon WebSocket bridge", () => {
  it("bridges output, raw input, control messages, resize, and reconnect replay", async () => {
    const fake = new FakePty();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-pty-ws-"));
    dirs.push(dir);
    const socketPath = path.join(dir, "pty.sock");
    const ptyDaemon = new PtyDaemonServer({
      socketPath,
      store: new PtySessionStore({ replayLimitBytes: 1024, spawnPty: () => fake }),
    });
    servers.push(ptyDaemon);
    await ptyDaemon.start();

    const httpServer = http.createServer();
    let resolveSessionReady!: () => void;
    const sessionReady = new Promise<void>((resolve) => {
      resolveSessionReady = resolve;
    });
    attachTerminalWebSocket(httpServer, (id) => {
      if (id !== "pty") return null;
      return {
        backend: "pty-daemon",
        sessionId: "pty-1",
        socketPath,
        cwd: dir,
        command: "bash",
        args: ["-l"],
        env: { TERM: "xterm-256color" },
        kind: "terminal",
        onSessionReady: resolveSessionReady,
      };
    });
    await listen(httpServer);
    try {
      const address = httpServer.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP test server address");
      const ws = new WebSocket(`ws://127.0.0.1:${address.port}/terminal/pty`);
      await waitForOpen(ws);
      await sessionReady;

      fake.emitData("READY\n");
      await waitForWebSocketOutput(ws, "READY");

      ws.send(Buffer.from("\u0003"));
      await waitFor(() => fake.writes.includes("\u0003"));

      ws.send(JSON.stringify({ type: "input", data: "\n" }));
      await waitFor(() => fake.writes.includes("\n"));

      ws.send(JSON.stringify({ type: "key", key: "C-u" }));
      await waitFor(() => fake.writes.includes("\u0015"));

      ws.send(JSON.stringify({ type: "resize", cols: 1000, rows: 1 }));
      await waitFor(() => fake.resizes.length === 1);
      expect(fake.resizes).toEqual([{ cols: 400, rows: 5 }]);

      ws.close();
      await waitForClose(ws);

      const reconnect = new WebSocket(`ws://127.0.0.1:${address.port}/terminal/pty`);
      await waitForOpen(reconnect);
      await waitForWebSocketOutput(reconnect, "READY");
      reconnect.close();
      await waitForClose(reconnect);
    } finally {
      await closeServer(httpServer);
    }
  });

  it("reconnects to a live PTY session after the Citadel websocket server restarts", async () => {
    const fake = new FakePty();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-pty-ws-"));
    dirs.push(dir);
    const socketPath = path.join(dir, "pty.sock");
    const ptyDaemon = new PtyDaemonServer({
      socketPath,
      store: new PtySessionStore({ replayLimitBytes: 1024, spawnPty: () => fake }),
    });
    servers.push(ptyDaemon);
    await ptyDaemon.start();

    const firstServer = await startGateway(socketPath, dir);
    const firstAddress = firstServer.server.address();
    if (!firstAddress || typeof firstAddress === "string") throw new Error("Expected TCP test server address");
    const ws = new WebSocket(`ws://127.0.0.1:${firstAddress.port}/terminal/pty`);
    await waitForOpen(ws);
    await firstServer.sessionReady;
    fake.emitData("SURVIVES\n");
    await waitForWebSocketOutput(ws, "SURVIVES");
    ws.close();
    await waitForClose(ws);
    await closeServer(firstServer.server);

    const restartedServer = await startGateway(socketPath, dir);
    try {
      const restartedAddress = restartedServer.server.address();
      if (!restartedAddress || typeof restartedAddress === "string")
        throw new Error("Expected TCP test server address");
      const reconnect = new WebSocket(`ws://127.0.0.1:${restartedAddress.port}/terminal/pty`);
      await waitForOpen(reconnect);
      await waitForWebSocketOutput(reconnect, "SURVIVES");
      reconnect.close();
      await waitForClose(reconnect);
    } finally {
      await closeServer(restartedServer.server);
    }
  });
});

class FakePty extends EventEmitter implements PtyLike {
  pid = 4242;
  process = "fake";
  writes: string[] = [];
  resizes: Array<{ cols: number; rows: number }> = [];
  kills: string[] = [];

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  kill(signal?: string): void {
    this.kills.push(signal ?? "");
    this.emit("exit", 0, 1);
  }

  onData(callback: (data: string) => void): { dispose: () => void } {
    this.on("data", callback);
    return { dispose: () => this.off("data", callback) };
  }

  onExit(callback: (event: { exitCode: number; signal?: number }) => void): { dispose: () => void } {
    const listener = (exitCode: number, signal?: number) =>
      callback(signal === undefined ? { exitCode } : { exitCode, signal });
    this.on("exit", listener);
    return { dispose: () => this.off("exit", listener) };
  }

  emitData(data: string): void {
    this.emit("data", data);
  }
}

function listen(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
}

async function startGateway(
  socketPath: string,
  cwd: string,
): Promise<{ server: http.Server; sessionReady: Promise<void> }> {
  const server = http.createServer();
  let resolveSessionReady!: () => void;
  const sessionReady = new Promise<void>((resolve) => {
    resolveSessionReady = resolve;
  });
  attachTerminalWebSocket(server, (id) =>
    id === "pty"
      ? {
          backend: "pty-daemon",
          sessionId: "pty-1",
          socketPath,
          cwd,
          command: "bash",
          args: ["-l"],
          env: { TERM: "xterm-256color" },
          kind: "terminal",
          onSessionReady: resolveSessionReady,
        }
      : null,
  );
  await listen(server);
  return { server, sessionReady };
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

function waitForClose(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    ws.once("close", () => resolve());
  });
}

function waitForWebSocketOutput(ws: WebSocket, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error(`Timed out waiting for ${expected}; saw ${buffer}`));
    }, 3000);
    const onMessage = (data: WebSocket.RawData) => {
      buffer += Buffer.isBuffer(data) ? data.toString("utf8") : data.toString();
      if (buffer.includes(expected)) {
        clearTimeout(timer);
        ws.off("message", onMessage);
        resolve();
      }
    };
    ws.on("message", onMessage);
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}
