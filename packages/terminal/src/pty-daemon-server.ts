import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import {
  PTY_DAEMON_PROTOCOL_VERSION,
  type PtyDaemonFrame,
  PtyDaemonFrameReader,
  type PtyDaemonMessage,
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
    } catch (error) {
      sendFrame(socket, toErrorMessage(error, requestIdFor(message)), undefined, this.#maxBufferedBytes);
    }
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
