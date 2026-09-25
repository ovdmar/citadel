import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { PtyDaemonHandoffMessage, PtyDaemonHandoffSnapshot } from "./pty-daemon-handoff.js";
import { clearHandoffSnapshot, writeHandoffSnapshot } from "./pty-daemon-handoff.js";
import {
  PTY_DAEMON_PROTOCOL_VERSION,
  type PtyDaemonFrame,
  PtyDaemonFrameReader,
  type PtyDaemonMessage,
  type PtyDaemonUpgradePreparedResult,
  encodePtyDaemonFrame,
} from "./pty-daemon-protocol.js";
import { PtySessionStore } from "./pty-daemon-store.js";

export type PtyDaemonServerOptions = {
  socketPath: string;
  store?: PtySessionStore;
  daemonVersion?: string;
  maxBufferedBytes?: number;
};

const DEFAULT_MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

export class PtyDaemonServer {
  readonly socketPath: string;
  readonly store: PtySessionStore;
  #server: net.Server | null = null;
  #sockets = new Set<net.Socket>();
  #daemonVersion: string;
  #maxBufferedBytes: number;

  constructor(options: PtyDaemonServerOptions) {
    this.socketPath = options.socketPath;
    this.store = options.store ?? new PtySessionStore();
    this.#daemonVersion = options.daemonVersion ?? "dev";
    this.#maxBufferedBytes = normalizeMaxBufferedBytes(options.maxBufferedBytes);
  }

  async start(): Promise<void> {
    if (this.#server) return;
    await fs.promises.mkdir(path.dirname(this.socketPath), { recursive: true, mode: 0o700 });
    try {
      await fs.promises.unlink(this.socketPath);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }
    const server = net.createServer((socket) => this.#handleConnection(socket));
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.socketPath);
    });
    await fs.promises.chmod(this.socketPath, 0o600);
  }

  async startWithRetry(timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown = null;
    while (Date.now() < deadline) {
      try {
        await this.start();
        return;
      } catch (error) {
        lastError = error;
        if (!isNodeError(error) || error.code !== "EADDRINUSE") throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    throw lastError ?? new Error("PTY daemon socket bind retry timed out");
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }).catch((error: unknown) => {
        if (!isNodeError(error) || error.code !== "ERR_SERVER_NOT_RUNNING") throw error;
      });
    }
    try {
      await fs.promises.unlink(this.socketPath);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }
  }

  #handleConnection(socket: net.Socket): void {
    const reader = new PtyDaemonFrameReader();
    const unsubscribers = new Map<string, () => void>();
    this.#sockets.add(socket);
    socket.on("close", () => {
      this.#sockets.delete(socket);
      for (const unsubscribe of unsubscribers.values()) unsubscribe();
      unsubscribers.clear();
    });
    socket.on("data", (chunk) => {
      let frames: PtyDaemonFrame[];
      try {
        frames = reader.push(chunk);
      } catch (error) {
        sendFrame(socket, toErrorMessage(error), undefined, this.#maxBufferedBytes);
        socket.destroy();
        return;
      }
      for (const frame of frames) {
        this.#handleMessage(socket, unsubscribers, frame.message, frame.payload);
      }
    });
  }

  #handleMessage(
    socket: net.Socket,
    unsubscribers: Map<string, () => void>,
    message: PtyDaemonMessage,
    payload: Buffer,
  ): void {
    try {
      if (message.type === "hello") {
        if (message.protocolVersion !== PTY_DAEMON_PROTOCOL_VERSION) {
          sendFrame(
            socket,
            errorMessage("protocol_version_mismatch", "Unsupported PTY daemon protocol version", message.requestId),
            undefined,
            this.#maxBufferedBytes,
          );
          socket.destroy();
          return;
        }
        const helloAck: PtyDaemonMessage = {
          type: "hello-ack",
          protocolVersion: PTY_DAEMON_PROTOCOL_VERSION,
          daemonVersion: this.#daemonVersion,
          maxHeaderBytes: 64 * 1024,
          maxPayloadBytes: 16 * 1024 * 1024,
        };
        if (message.requestId) helloAck.requestId = message.requestId;
        sendFrame(socket, helloAck, undefined, this.#maxBufferedBytes);
        return;
      }
      if (message.type === "ping") {
        const pong: PtyDaemonMessage = { type: "pong" };
        if (message.requestId) pong.requestId = message.requestId;
        sendFrame(socket, pong, undefined, this.#maxBufferedBytes);
        return;
      }
      if (message.type === "open") {
        const session = this.store.open({
          sessionId: message.sessionId,
          cwd: message.cwd,
          command: message.command,
          args: message.args ?? [],
          env: message.env ?? {},
          cols: message.cols,
          rows: message.rows,
          kind: message.kind ?? "terminal",
        });
        sendFrame(
          socket,
          { type: "open-result", requestId: message.requestId, session },
          undefined,
          this.#maxBufferedBytes,
        );
        return;
      }
      if (message.type === "list") {
        sendFrame(
          socket,
          { type: "list-result", requestId: message.requestId, sessions: this.store.list() },
          undefined,
          this.#maxBufferedBytes,
        );
        return;
      }
      if (message.type === "subscribe") {
        unsubscribers.get(message.sessionId)?.();
        const unsubscribe = this.store.subscribe(message.sessionId, {
          replay: false,
          onOutput: (chunk) =>
            sendFrame(socket, { type: "output", sessionId: message.sessionId }, chunk, this.#maxBufferedBytes),
          onExit: (event) => {
            const exit: PtyDaemonMessage = { type: "exit", sessionId: message.sessionId, exitCode: event.exitCode };
            if (event.signal !== undefined) exit.signal = event.signal;
            sendFrame(socket, exit, undefined, this.#maxBufferedBytes);
          },
        });
        unsubscribers.set(message.sessionId, unsubscribe);
        sendFrame(
          socket,
          { type: "subscribe-result", requestId: message.requestId, sessionId: message.sessionId },
          undefined,
          this.#maxBufferedBytes,
        );
        if (message.replay) {
          const replay = this.store.replay(message.sessionId);
          if (replay.length > 0) {
            sendFrame(socket, { type: "output", sessionId: message.sessionId }, replay, this.#maxBufferedBytes);
          }
        }
        return;
      }
      if (message.type === "unsubscribe") {
        unsubscribers.get(message.sessionId)?.();
        unsubscribers.delete(message.sessionId);
        return;
      }
      if (message.type === "input") {
        this.store.input(message.sessionId, payload);
        return;
      }
      if (message.type === "resize") {
        this.store.resize(message.sessionId, message.cols, message.rows);
        return;
      }
      if (message.type === "capture") {
        sendFrame(
          socket,
          {
            type: "capture-result",
            requestId: message.requestId,
            capture: this.store.capture(message.sessionId, captureOptions(message)),
          },
          undefined,
          this.#maxBufferedBytes,
        );
        return;
      }
      if (message.type === "close") {
        this.store.close(message.sessionId);
        return;
      }
      if (message.type === "prepare-upgrade") {
        void this.prepareUpgrade()
          .then((result) => {
            sendFrame(
              socket,
              { type: "upgrade-prepared", requestId: message.requestId, result },
              undefined,
              this.#maxBufferedBytes,
            );
          })
          .catch((error) => {
            sendFrame(
              socket,
              {
                type: "upgrade-prepared",
                requestId: message.requestId,
                result: { ok: false, reason: error instanceof Error ? error.message : "prepare_upgrade_failed" },
              },
              undefined,
              this.#maxBufferedBytes,
            );
          });
        return;
      }
    } catch (error) {
      sendFrame(socket, toErrorMessage(error, requestIdFor(message)), undefined, this.#maxBufferedBytes);
    }
  }

  adoptSnapshot(snapshot: PtyDaemonHandoffSnapshot): void {
    for (const session of snapshot.sessions) this.store.adopt(session);
  }

  async prepareUpgrade(): Promise<PtyDaemonUpgradePreparedResult> {
    const liveFds = this.store.liveSessionMasterFds();
    const fdIndexBySessionId = new Map<string, number>();
    const handoffFdBase = 4;
    const stdio: Array<"ignore" | "inherit" | "ipc" | number> = ["ignore", "inherit", "inherit", "ipc"];
    for (const [index, session] of liveFds.entries()) {
      const fdIndex = handoffFdBase + index;
      fdIndexBySessionId.set(session.sessionId, fdIndex);
      stdio.push(session.fd);
    }

    const snapshotPath = path.join(os.tmpdir(), `citadel-pty-daemon-handoff-${process.pid}-${Date.now()}.snap`);
    try {
      writeHandoffSnapshot(snapshotPath, this.store.handoffSnapshot(fdIndexBySessionId));
    } catch (error) {
      return { ok: false, reason: `snapshot write failed: ${stringifyError(error)}` };
    }

    const scriptPath = process.argv[1];
    if (!scriptPath) {
      clearHandoffSnapshot(snapshotPath);
      return { ok: false, reason: "PTY daemon cannot self-spawn without process.argv[1]" };
    }

    let child: ChildProcess;
    try {
      child = spawn(
        process.execPath,
        [...process.execArgv, scriptPath, "--handoff", `--snapshot=${snapshotPath}`, `--socket=${this.socketPath}`],
        {
          detached: false,
          env: { ...process.env },
          stdio,
        },
      );
    } catch (error) {
      clearHandoffSnapshot(snapshotPath);
      return { ok: false, reason: `successor spawn failed: ${stringifyError(error)}` };
    }

    const result = await waitForHandoffAck(child);
    if (!result.ok) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      clearHandoffSnapshot(snapshotPath);
      return result;
    }

    setImmediate(() => {
      void this.finalizeHandoff();
    });
    return { ok: true, successorPid: result.successorPid };
  }

  async finalizeHandoff(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    await this.close();
    setTimeout(() => process.exit(0), 50).unref();
  }
}

function sendFrame(
  socket: net.Socket,
  message: PtyDaemonMessage,
  payload: Buffer | undefined,
  maxBufferedBytes: number,
): void {
  if (socket.destroyed) return;
  if (socket.writableLength > maxBufferedBytes) {
    socket.destroy();
    return;
  }
  socket.write(encodePtyDaemonFrame(message, payload));
  if (socket.writableLength > maxBufferedBytes) socket.destroy();
}

function toErrorMessage(error: unknown, requestId?: string): PtyDaemonMessage {
  const detail = error instanceof Error ? error.message : "Unknown PTY daemon error";
  const code = detail.includes("pty_session_missing") ? "pty_session_missing" : "pty_daemon_error";
  return errorMessage(code, detail, requestId);
}

function errorMessage(code: string, message: string, requestId?: string): PtyDaemonMessage {
  const response: PtyDaemonMessage = { type: "error", code, message };
  if (requestId) response.requestId = requestId;
  return response;
}

function captureOptions(message: Extract<PtyDaemonMessage, { type: "capture" }>): {
  lines?: number;
  maxChars?: number;
} {
  const options: { lines?: number; maxChars?: number } = {};
  if (message.lines !== undefined) options.lines = message.lines;
  if (message.maxChars !== undefined) options.maxChars = message.maxChars;
  return options;
}

function requestIdFor(message: PtyDaemonMessage): string | undefined {
  return "requestId" in message ? message.requestId : undefined;
}

function normalizeMaxBufferedBytes(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return DEFAULT_MAX_BUFFERED_BYTES;
  return Math.max(1024, Math.trunc(value));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function waitForHandoffAck(
  child: ChildProcess,
): Promise<{ ok: true; successorPid: number } | { ok: false; reason: string }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve({ ok: false, reason: "successor handoff ack timed out" });
    }, 5000);
    timer.unref();
    const cleanup = () => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    const onMessage = (message: unknown) => {
      const handoff = message as PtyDaemonHandoffMessage;
      if (handoff?.type === "upgrade-ack") {
        cleanup();
        resolve({ ok: true, successorPid: handoff.successorPid });
      } else if (handoff?.type === "upgrade-nak") {
        cleanup();
        resolve({ ok: false, reason: handoff.reason });
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      resolve({ ok: false, reason: `successor exited before ack code=${code ?? "null"} signal=${signal ?? "null"}` });
    };
    const onError = (error: Error) => {
      cleanup();
      resolve({ ok: false, reason: `successor error before ack: ${error.message}` });
    };
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}
