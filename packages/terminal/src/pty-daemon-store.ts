import { spawnSync } from "node:child_process";
import fs from "node:fs";
import tty from "node:tty";
import { spawn } from "node-pty";
import {
  PTY_DAEMON_HANDOFF_SNAPSHOT_VERSION,
  type PtyDaemonHandoffSession,
  type PtyDaemonHandoffSnapshot,
} from "./pty-daemon-handoff.js";
import type { PtyDaemonCaptureResult, PtyDaemonSessionInfo } from "./pty-daemon-protocol.js";
import { clampSize } from "./tmux-pty-bridge.js";

export type PtyLike = {
  readonly pid: number;
  readonly process: string;
  getMasterFd(): number;
  write(data: Buffer): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(callback: (data: Buffer) => void): { dispose: () => void };
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

type ReplayBuffer = {
  chunks: Buffer[];
  bytes: number;
};

type SessionRecord = {
  sessionId: string;
  pty: PtyLike;
  cwd: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cols: number;
  rows: number;
  kind: string;
  createdAt: string;
  lastOutputAt: string | null;
  exitedAt: string | null;
  exitCode: number | null;
  signal: number | null;
  replay: ReplayBuffer;
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
    return toSessionInfo(this.#addRecord(normalized, pty, {}));
  }

  adopt(session: PtyDaemonHandoffSession): PtyDaemonSessionInfo {
    const existing = this.#sessions.get(session.sessionId);
    if (existing) return toSessionInfo(existing);
    const pty = adoptPtyFromFd({
      fd: session.fdIndex,
      pid: session.pid,
      cols: session.cols,
      rows: session.rows,
      processName: session.command,
    });
    const request: PtySessionOpenRequest = {
      sessionId: session.sessionId,
      cwd: session.cwd,
      command: session.command,
      args: [...session.args],
      env: { ...session.env },
      cols: session.cols,
      rows: session.rows,
      kind: session.kind,
    };
    return toSessionInfo(
      this.#addRecord(request, pty, {
        createdAt: session.createdAt,
        lastOutputAt: session.lastOutputAt,
        replay: session.replay,
      }),
    );
  }

  handoffSnapshot(fdIndexBySessionId: Map<string, number>): PtyDaemonHandoffSnapshot {
    const sessions: PtyDaemonHandoffSession[] = [];
    for (const record of this.#sessions.values()) {
      if (record.exitedAt) continue;
      const fdIndex = fdIndexBySessionId.get(record.sessionId);
      if (fdIndex === undefined) throw new Error(`missing handoff fd index for ${record.sessionId}`);
      sessions.push({
        sessionId: record.sessionId,
        pid: record.pty.pid,
        fdIndex,
        cwd: record.cwd,
        command: record.command,
        args: [...record.args],
        env: { ...record.env },
        cols: record.cols,
        rows: record.rows,
        kind: record.kind,
        createdAt: record.createdAt,
        lastOutputAt: record.lastOutputAt,
        replay: replaySnapshot(record.replay),
      });
    }
    return {
      version: PTY_DAEMON_HANDOFF_SNAPSHOT_VERSION,
      writtenAt: new Date().toISOString(),
      sessions,
    };
  }

  liveSessionMasterFds(): Array<{ sessionId: string; fd: number }> {
    const fds: Array<{ sessionId: string; fd: number }> = [];
    for (const record of this.#sessions.values()) {
      if (record.exitedAt) continue;
      fds.push({ sessionId: record.sessionId, fd: record.pty.getMasterFd() });
    }
    return fds;
  }

  #addRecord(
    request: PtySessionOpenRequest,
    pty: PtyLike,
    options: { createdAt?: string; lastOutputAt?: string | null; replay?: Buffer },
  ): SessionRecord {
    const size = clampSize(request.cols, request.rows);
    const record: SessionRecord = {
      sessionId: request.sessionId,
      pty,
      cwd: request.cwd,
      command: request.command,
      args: [...request.args],
      env: { ...request.env },
      cols: size.cols,
      rows: size.rows,
      kind: request.kind,
      createdAt: options.createdAt ?? new Date().toISOString(),
      lastOutputAt: options.lastOutputAt ?? null,
      exitedAt: null,
      exitCode: null,
      signal: null,
      replay: { chunks: [], bytes: 0 },
      subscribers: new Set(),
      disposables: [],
    };
    record.disposables.push(
      pty.onData((data) => {
        const chunk = Buffer.from(data);
        record.lastOutputAt = new Date().toISOString();
        appendReplay(record.replay, chunk, this.#replayLimitBytes);
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
    if (options.replay) {
      appendReplay(record.replay, options.replay, this.#replayLimitBytes);
    }
    this.#sessions.set(request.sessionId, record);
    return record;
  }

  list(): PtyDaemonSessionInfo[] {
    return [...this.#sessions.values()].map(toSessionInfo);
  }

  has(sessionId: string): boolean {
    return this.#sessions.has(sessionId);
  }

  input(sessionId: string, data: Buffer): void {
    this.#requireSession(sessionId).pty.write(data);
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
    if (options.replay && record.replay.bytes > 0) options.onOutput(replaySnapshot(record.replay));
    return () => {
      record.subscribers.delete(subscriber);
    };
  }

  replay(sessionId: string): Buffer {
    return replaySnapshot(this.#requireSession(sessionId).replay);
  }

  capture(sessionId: string, options: { lines?: number; maxChars?: number } = {}): PtyDaemonCaptureResult {
    const record = this.#sessions.get(sessionId);
    if (!record) return { ok: false, error: "pty_session_missing" };
    const maxChars = normalizeMaxChars(options.maxChars);
    const lines = normalizeLines(options.lines);
    const rendered = stripAnsi(replaySnapshot(record.replay).toString("utf8"))
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n");
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
  const pty = spawn(request.command, request.args, {
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
    encoding: null,
  });
  const masterFd = nodePtyMasterFd(pty);
  return {
    pid: pty.pid,
    process: pty.process,
    getMasterFd() {
      return masterFd;
    },
    write(data: Buffer) {
      pty.write(data);
    },
    resize(cols: number, rows: number) {
      pty.resize(cols, rows);
    },
    kill(signal?: string) {
      pty.kill(signal);
    },
    onData(callback: (data: Buffer) => void) {
      return pty.onData((data: string | Buffer) => {
        callback(typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data));
      });
    },
    onExit(callback: (event: { exitCode: number; signal?: number }) => void) {
      return pty.onExit(callback);
    },
  };
}

function adoptPtyFromFd(input: {
  fd: number;
  pid: number;
  cols: number;
  rows: number;
  processName: string;
}): PtyLike {
  return new AdoptedPty(input);
}

class AdoptedPty implements PtyLike {
  readonly pid: number;
  readonly process: string;
  #fd: number;
  #reader: tty.ReadStream;
  #exited = false;
  #exitCallbacks = new Set<(event: { exitCode: number; signal?: number }) => void>();
  #livenessTimer: NodeJS.Timeout;

  constructor(input: { fd: number; pid: number; cols: number; rows: number; processName: string }) {
    if (!Number.isInteger(input.fd) || input.fd < 0) throw new Error(`invalid inherited PTY fd: ${input.fd}`);
    if (!Number.isInteger(input.pid) || input.pid <= 0) throw new Error(`invalid inherited PTY pid: ${input.pid}`);
    this.#fd = input.fd;
    this.pid = input.pid;
    this.process = input.processName;
    this.#reader = new tty.ReadStream(input.fd);
    const fireExit = () => this.#fireExit({ exitCode: 0 });
    this.#reader.on("end", fireExit);
    this.#reader.on("error", fireExit);
    this.#livenessTimer = setInterval(() => {
      if (!isPidAlive(this.pid)) this.#fireExit({ exitCode: 0 });
    }, 1000);
    this.#livenessTimer.unref();
    this.resize(input.cols, input.rows);
  }

  getMasterFd(): number {
    return this.#fd;
  }

  write(data: Buffer): void {
    if (this.#exited) throw new Error(`pty_session_exited:${this.pid}`);
    let offset = 0;
    while (offset < data.byteLength) {
      const written = fs.writeSync(this.#fd, data, offset, data.byteLength - offset);
      if (written <= 0) throw new Error(`PTY fd write returned ${written}`);
      offset += written;
    }
  }

  resize(cols: number, rows: number): void {
    spawnSync("stty", ["cols", String(cols), "rows", String(rows)], {
      stdio: [this.#fd, "ignore", "ignore"],
      timeout: 1000,
    });
  }

  kill(signal?: string): void {
    try {
      process.kill(this.pid, signal ?? "SIGHUP");
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ESRCH") throw error;
    }
  }

  onData(callback: (data: Buffer) => void): { dispose: () => void } {
    const listener = (chunk: Buffer | string) => {
      callback(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk));
    };
    this.#reader.on("data", listener);
    return { dispose: () => this.#reader.off("data", listener) };
  }

  onExit(callback: (event: { exitCode: number; signal?: number }) => void): { dispose: () => void } {
    this.#exitCallbacks.add(callback);
    return { dispose: () => this.#exitCallbacks.delete(callback) };
  }

  #fireExit(event: { exitCode: number; signal?: number }): void {
    if (this.#exited) return;
    this.#exited = true;
    clearInterval(this.#livenessTimer);
    try {
      this.#reader.destroy();
    } catch {
      /* already closed */
    }
    for (const callback of this.#exitCallbacks) callback(event);
  }
}

function nodePtyMasterFd(pty: unknown): number {
  const fd = (pty as { _fd?: unknown })._fd;
  if (typeof fd !== "number" || !Number.isInteger(fd) || fd < 0) {
    throw new Error(`node-pty master fd unavailable for PTY daemon handoff: ${String(fd)}`);
  }
  return fd;
}

function appendReplay(replay: ReplayBuffer, chunk: Buffer, limit: number): void {
  if (chunk.length === 0) return;
  const bounded = chunk.length > limit ? chunk.subarray(chunk.length - limit) : chunk;
  replay.chunks.push(Buffer.from(bounded));
  replay.bytes += bounded.length;
  while (replay.bytes > limit && replay.chunks.length > 0) {
    const overflow = replay.bytes - limit;
    const first = replay.chunks[0];
    if (!first) break;
    if (first.length <= overflow) {
      replay.bytes -= first.length;
      replay.chunks.shift();
    } else {
      replay.chunks[0] = first.subarray(overflow);
      replay.bytes -= overflow;
    }
  }
}

function replaySnapshot(replay: ReplayBuffer): Buffer {
  return Buffer.concat(replay.chunks, replay.bytes);
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

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM";
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
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
