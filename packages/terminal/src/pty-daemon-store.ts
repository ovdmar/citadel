import { spawn } from "node-pty";
import type { PtyDaemonCaptureResult, PtyDaemonSessionInfo } from "./pty-daemon-protocol.js";
import { clampSize } from "./tmux-pty-bridge.js";

export type PtyLike = {
  readonly pid: number;
  readonly process: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(callback: (data: string) => void): { dispose: () => void };
  onExit(callback: (event: { exitCode: number; signal?: number }) => void): { dispose: () => void };
};

export type PtySessionOpenRequest = {
  sessionId: string;
  cwd: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cols: number;
  rows: number;
  kind: string;
};

export type PtySessionStoreOptions = {
  replayLimitBytes?: number;
  spawnPty?: (request: PtySessionOpenRequest) => PtyLike;
};

type Subscriber = {
  onOutput: (chunk: Buffer) => void;
  onExit?: (event: { exitCode: number; signal?: number }) => void;
};

type SessionRecord = {
  sessionId: string;
  pty: PtyLike;
  cwd: string;
  command: string;
  args: string[];
  cols: number;
  rows: number;
  kind: string;
  createdAt: string;
  lastOutputAt: string | null;
  exitedAt: string | null;
  exitCode: number | null;
  signal: number | null;
  replay: Buffer;
  subscribers: Set<Subscriber>;
  disposables: Array<{ dispose: () => void }>;
};

const DEFAULT_REPLAY_LIMIT_BYTES = 1024 * 1024;

export class PtySessionStore {
  #sessions = new Map<string, SessionRecord>();
  #replayLimitBytes: number;
  #spawnPty: (request: PtySessionOpenRequest) => PtyLike;

  constructor(options: PtySessionStoreOptions = {}) {
    this.#replayLimitBytes = normalizeReplayLimit(options.replayLimitBytes);
    this.#spawnPty = options.spawnPty ?? spawnNodePty;
  }

  open(request: PtySessionOpenRequest): PtyDaemonSessionInfo {
    const existing = this.#sessions.get(request.sessionId);
    if (existing) return toSessionInfo(existing);
    const size = clampSize(request.cols, request.rows);
    const normalized: PtySessionOpenRequest = {
      ...request,
      cols: size.cols,
      rows: size.rows,
      args: [...request.args],
      env: { ...request.env },
    };
    const pty = this.#spawnPty(normalized);
    const record: SessionRecord = {
      sessionId: request.sessionId,
      pty,
      cwd: request.cwd,
      command: request.command,
      args: [...request.args],
      cols: size.cols,
      rows: size.rows,
      kind: request.kind,
      createdAt: new Date().toISOString(),
      lastOutputAt: null,
      exitedAt: null,
      exitCode: null,
      signal: null,
      replay: Buffer.alloc(0),
      subscribers: new Set(),
      disposables: [],
    };
    record.disposables.push(
      pty.onData((data) => {
        const chunk = Buffer.from(data, "utf8");
        record.lastOutputAt = new Date().toISOString();
        record.replay = appendReplay(record.replay, chunk, this.#replayLimitBytes);
        for (const subscriber of record.subscribers) subscriber.onOutput(chunk);
      }),
    );
    record.disposables.push(
      pty.onExit(({ exitCode, signal }) => {
        record.exitedAt = new Date().toISOString();
        record.exitCode = exitCode;
        record.signal = signal ?? null;
        const event = signal === undefined ? { exitCode } : { exitCode, signal };
        for (const subscriber of record.subscribers) subscriber.onExit?.(event);
      }),
    );
    this.#sessions.set(request.sessionId, record);
    return toSessionInfo(record);
  }

  list(): PtyDaemonSessionInfo[] {
    return [...this.#sessions.values()].map(toSessionInfo);
  }

  has(sessionId: string): boolean {
    return this.#sessions.has(sessionId);
  }

  input(sessionId: string, data: Buffer): void {
    this.#requireSession(sessionId).pty.write(data.toString("utf8"));
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const record = this.#requireSession(sessionId);
    const size = clampSize(cols, rows);
    record.cols = size.cols;
    record.rows = size.rows;
    record.pty.resize(size.cols, size.rows);
  }

  subscribe(
    sessionId: string,
    options: {
      replay?: boolean;
      onOutput: (chunk: Buffer) => void;
      onExit?: (event: { exitCode: number; signal?: number }) => void;
    },
  ): () => void {
    const record = this.#requireSession(sessionId);
    const subscriber: Subscriber = { onOutput: options.onOutput };
    if (options.onExit) subscriber.onExit = options.onExit;
    record.subscribers.add(subscriber);
    if (options.replay && record.replay.length > 0) options.onOutput(Buffer.from(record.replay));
    return () => {
      record.subscribers.delete(subscriber);
    };
  }

  replay(sessionId: string): Buffer {
    return Buffer.from(this.#requireSession(sessionId).replay);
  }

  capture(sessionId: string, options: { lines?: number; maxChars?: number } = {}): PtyDaemonCaptureResult {
    const record = this.#sessions.get(sessionId);
    if (!record) return { ok: false, error: "pty_session_missing" };
    const maxChars = normalizeMaxChars(options.maxChars);
    const lines = normalizeLines(options.lines);
    const rendered = stripAnsi(record.replay.toString("utf8")).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const renderedLines = rendered.split("\n");
    if (renderedLines.at(-1) === "") renderedLines.pop();
    const lineBounded = renderedLines.slice(-lines).join("\n");
    const truncated = lineBounded.length > maxChars;
    const text = truncated ? lineBounded.slice(lineBounded.length - maxChars) : lineBounded;
    return { ok: true, sessionId, text, charCount: text.length, truncated };
  }

  close(sessionId: string): void {
    const record = this.#sessions.get(sessionId);
    if (!record) return;
    this.#sessions.delete(sessionId);
    for (const disposable of record.disposables) disposable.dispose();
    record.subscribers.clear();
    try {
      record.pty.kill("SIGHUP");
    } catch {
      /* already gone */
    }
  }

  closeAll(): void {
    for (const sessionId of [...this.#sessions.keys()]) this.close(sessionId);
  }

  #requireSession(sessionId: string): SessionRecord {
    const record = this.#sessions.get(sessionId);
    if (!record) throw new Error(`pty_session_missing:${sessionId}`);
    return record;
  }
}

function spawnNodePty(request: PtySessionOpenRequest): PtyLike {
  return spawn(request.command, request.args, {
    name: "xterm-256color",
    cols: request.cols,
    rows: request.rows,
    cwd: request.cwd,
    env: {
      ...process.env,
      ...request.env,
      TERM: request.env.TERM ?? "xterm-256color",
      COLORTERM: request.env.COLORTERM ?? "truecolor",
      FORCE_COLOR: request.env.FORCE_COLOR ?? "1",
      CLICOLOR_FORCE: request.env.CLICOLOR_FORCE ?? "1",
    },
    encoding: "utf8",
  });
}

function appendReplay(current: Buffer, chunk: Buffer, limit: number): Buffer {
  const next = Buffer.concat([current, chunk]);
  if (next.length <= limit) return next;
  return next.subarray(next.length - limit);
}

function normalizeReplayLimit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return DEFAULT_REPLAY_LIMIT_BYTES;
  return Math.max(1, Math.trunc(value));
}

function normalizeLines(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 200;
  return Math.min(10_000, Math.trunc(value));
}

function normalizeMaxChars(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 20_000;
  return Math.min(500_000, Math.trunc(value));
}

function stripAnsi(value: string): string {
  const ansiPattern = "\\u001b\\[[0-?]*[ -/]*[@-~]";
  return value.replace(new RegExp(ansiPattern, "g"), "");
}

function toSessionInfo(record: SessionRecord): PtyDaemonSessionInfo {
  return {
    sessionId: record.sessionId,
    pid: record.pty.pid,
    cwd: record.cwd,
    command: record.command,
    args: [...record.args],
    cols: record.cols,
    rows: record.rows,
    kind: record.kind,
    createdAt: record.createdAt,
    lastOutputAt: record.lastOutputAt,
    exitedAt: record.exitedAt,
    exitCode: record.exitCode,
    signal: record.signal,
  };
}
