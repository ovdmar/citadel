import net from "node:net";
import {
  PTY_DAEMON_PROTOCOL_VERSION,
  type PtyDaemonCaptureResult,
  type PtyDaemonFrame,
  PtyDaemonFrameReader,
  type PtyDaemonMessage,
  type PtyDaemonSessionInfo,
  encodePtyDaemonFrame,
} from "./pty-daemon-protocol.js";

export type ConnectPtyDaemonClientOptions = {
  socketPath: string;
  timeoutMs?: number;
};

export type PtyDaemonClientSubscription = {
  replay?: boolean;
  onOutput: (chunk: Buffer) => void;
  onExit?: (event: { exitCode: number; signal?: number }) => void;
};

type PendingRequest = {
  resolve: (message: PtyDaemonMessage) => void;
  reject: (error: Error) => void;
};

type Subscription = {
  onOutput: (chunk: Buffer) => void;
  onExit?: (event: { exitCode: number; signal?: number }) => void;
};

export async function connectPtyDaemonClient(options: ConnectPtyDaemonClientOptions): Promise<PtyDaemonClient> {
  const socket = net.createConnection(options.socketPath);
  await waitForSocketConnect(socket, options.timeoutMs ?? 3000);
  const client = new PtyDaemonClient(socket);
  const response = await client.request({
    type: "hello",
    requestId: client.nextRequestId(),
    protocolVersion: PTY_DAEMON_PROTOCOL_VERSION,
  });
  if (response.type !== "hello-ack") {
    client.dispose();
    throw new Error(`Expected hello-ack, received ${response.type}`);
  }
  return client;
}

export class PtyDaemonClient {
  #socket: net.Socket;
  #reader = new PtyDaemonFrameReader();
  #pending = new Map<string, PendingRequest>();
  #subscriptions = new Map<string, Subscription>();
  #nextRequest = 0;
  #disposed = false;

  constructor(socket: net.Socket) {
    this.#socket = socket;
    socket.on("data", (chunk) => this.#handleData(chunk));
    socket.on("close", () => this.#rejectPending("PTY daemon socket closed"));
    socket.on("error", (error) => this.#rejectPending(error.message));
  }

  nextRequestId(): string {
    this.#nextRequest += 1;
    return `pty-req-${this.#nextRequest}`;
  }

  async open(input: {
    sessionId: string;
    cwd: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
    cols: number;
    rows: number;
    kind?: string;
    metadata?: Record<string, string>;
  }): Promise<PtyDaemonSessionInfo> {
    const requestId = this.nextRequestId();
    const message: PtyDaemonMessage = {
      type: "open",
      requestId,
      sessionId: input.sessionId,
      cwd: input.cwd,
      command: input.command,
      args: input.args ?? [],
      env: input.env ?? {},
      cols: input.cols,
      rows: input.rows,
      kind: input.kind ?? "terminal",
    };
    if (input.metadata) message.metadata = input.metadata;
    const response = await this.request(message);
    if (response.type !== "open-result") throw new Error(`Expected open-result, received ${response.type}`);
    return response.session;
  }

  async list(): Promise<PtyDaemonSessionInfo[]> {
    const requestId = this.nextRequestId();
    const response = await this.request({ type: "list", requestId });
    if (response.type !== "list-result") throw new Error(`Expected list-result, received ${response.type}`);
    return response.sessions;
  }

  async subscribe(sessionId: string, subscription: PtyDaemonClientSubscription): Promise<() => void> {
    this.#subscriptions.set(sessionId, subscription);
    const requestId = this.nextRequestId();
    try {
      const message: PtyDaemonMessage = { type: "subscribe", requestId, sessionId };
      if (subscription.replay !== undefined) message.replay = subscription.replay;
      const response = await this.request(message);
      if (response.type !== "subscribe-result") {
        throw new Error(`Expected subscribe-result, received ${response.type}`);
      }
      return () => {
        this.#subscriptions.delete(sessionId);
        this.#send({ type: "unsubscribe", sessionId });
      };
    } catch (error) {
      this.#subscriptions.delete(sessionId);
      throw error;
    }
  }

  input(sessionId: string, payload: Buffer): void {
    this.#send({ type: "input", sessionId }, payload);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.#send({ type: "resize", sessionId, cols, rows });
  }

  async capture(
    sessionId: string,
    options: { lines?: number; maxChars?: number } = {},
  ): Promise<PtyDaemonCaptureResult> {
    const requestId = this.nextRequestId();
    const message: PtyDaemonMessage = {
      type: "capture",
      requestId,
      sessionId,
    };
    if (options.lines !== undefined) message.lines = options.lines;
    if (options.maxChars !== undefined) message.maxChars = options.maxChars;
    const response = await this.request(message);
    if (response.type !== "capture-result") throw new Error(`Expected capture-result, received ${response.type}`);
    return response.capture;
  }

  closeSession(sessionId: string): void {
    this.#send({ type: "close", sessionId });
  }

  request(message: PtyDaemonMessage, payload?: Buffer): Promise<PtyDaemonMessage> {
    if (!("requestId" in message) || !message.requestId) {
      throw new Error(`PTY daemon request ${message.type} requires requestId`);
    }
    const requestId = message.requestId;
    const promise = new Promise<PtyDaemonMessage>((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject });
    });
    this.#send(message, payload);
    return promise;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#subscriptions.clear();
    this.#rejectPending("PTY daemon client disposed");
    this.#socket.destroy();
  }

  #handleData(chunk: Buffer): void {
    let frames: PtyDaemonFrame[];
    try {
      frames = this.#reader.push(chunk);
    } catch (error) {
      this.#rejectPending(error instanceof Error ? error.message : "Invalid PTY daemon frame");
      this.dispose();
      return;
    }
    for (const frame of frames) {
      const { message, payload } = frame;
      if (message.type === "output") {
        this.#subscriptions.get(message.sessionId)?.onOutput(payload);
        continue;
      }
      if (message.type === "exit") {
        const event =
          message.signal === undefined
            ? { exitCode: message.exitCode }
            : { exitCode: message.exitCode, signal: message.signal };
        this.#subscriptions.get(message.sessionId)?.onExit?.(event);
        continue;
      }
      if (message.type === "error") {
        if (message.requestId) {
          const pending = this.#pending.get(message.requestId);
          if (pending) {
            this.#pending.delete(message.requestId);
            pending.reject(new Error(`${message.code}:${message.message}`));
          }
        }
        continue;
      }
      if ("requestId" in message && message.requestId) {
        const pending = this.#pending.get(message.requestId);
        if (pending) {
          this.#pending.delete(message.requestId);
          pending.resolve(message);
        }
      }
    }
  }

  #send(message: PtyDaemonMessage, payload?: Buffer): void {
    if (this.#disposed) return;
    this.#socket.write(encodePtyDaemonFrame(message, payload));
  }

  #rejectPending(reason: string): void {
    for (const [requestId, pending] of this.#pending) {
      this.#pending.delete(requestId);
      pending.reject(new Error(reason));
    }
  }
}

function waitForSocketConnect(socket: net.Socket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error("PTY daemon socket connection timed out"));
    }, timeoutMs);
    timer.unref();
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("connect", onConnect);
      socket.off("error", onError);
    };
    const onConnect = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}
