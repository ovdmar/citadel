export const PTY_DAEMON_PROTOCOL_VERSION = 1;
export const MAX_PTY_DAEMON_HEADER_BYTES = 64 * 1024;
export const MAX_PTY_DAEMON_PAYLOAD_BYTES = 16 * 1024 * 1024;

export type PtyDaemonMessage =
  | { type: "hello"; requestId?: string; protocolVersion: number }
  | {
      type: "hello-ack";
      requestId?: string;
      protocolVersion: number;
      daemonVersion: string;
      maxHeaderBytes: number;
      maxPayloadBytes: number;
    }
  | { type: "ping"; requestId?: string }
  | { type: "pong"; requestId?: string }
  | {
      type: "open";
      requestId: string;
      sessionId: string;
      cwd: string;
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cols: number;
      rows: number;
      kind?: string;
      metadata?: Record<string, string>;
    }
  | { type: "open-result"; requestId: string; session: PtyDaemonSessionInfo }
  | { type: "list"; requestId: string }
  | { type: "list-result"; requestId: string; sessions: PtyDaemonSessionInfo[] }
  | { type: "subscribe"; requestId: string; sessionId: string; replay?: boolean }
  | { type: "subscribe-result"; requestId: string; sessionId: string }
  | { type: "unsubscribe"; requestId?: string; sessionId: string }
  | { type: "input"; requestId?: string; sessionId: string }
  | { type: "resize"; requestId?: string; sessionId: string; cols: number; rows: number }
  | { type: "capture"; requestId: string; sessionId: string; lines?: number; maxChars?: number }
  | { type: "capture-result"; requestId: string; capture: PtyDaemonCaptureResult }
  | { type: "close"; requestId?: string; sessionId: string }
  | { type: "prepare-upgrade"; requestId: string }
  | { type: "upgrade-prepared"; requestId: string; result: PtyDaemonUpgradePreparedResult }
  | { type: "output"; sessionId: string }
  | { type: "exit"; sessionId: string; exitCode: number; signal?: number }
  | { type: "error"; requestId?: string; code: string; message: string };

export type PtyDaemonSessionInfo = {
  sessionId: string;
  pid: number;
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
};

export type PtyDaemonCaptureResult =
  | { ok: true; sessionId: string; text: string; charCount: number; truncated: boolean }
  | { ok: false; error: "pty_session_missing" };

export type PtyDaemonUpgradePreparedResult = { ok: true; successorPid: number } | { ok: false; reason: string };

export type PtyDaemonFrame = {
  message: PtyDaemonMessage;
  payload: Buffer;
};

export function encodePtyDaemonFrame(message: PtyDaemonMessage, payload: Buffer = Buffer.alloc(0)): Buffer {
  const header = Buffer.from(JSON.stringify(message), "utf8");
  if (header.length > MAX_PTY_DAEMON_HEADER_BYTES) throw new Error("pty_daemon_header_too_large");
  if (payload.length > MAX_PTY_DAEMON_PAYLOAD_BYTES) throw new Error("pty_daemon_payload_too_large");
  const prefix = Buffer.alloc(8);
  prefix.writeUInt32BE(header.length, 0);
  prefix.writeUInt32BE(payload.length, 4);
  return Buffer.concat([prefix, header, payload]);
}

export class PtyDaemonFrameReader {
  #buffer = Buffer.alloc(0);

  push(chunk: Buffer): PtyDaemonFrame[] {
    if (chunk.length > 0) this.#buffer = Buffer.concat([this.#buffer, chunk]);
    const frames: PtyDaemonFrame[] = [];
    while (this.#buffer.length >= 8) {
      const headerLength = this.#buffer.readUInt32BE(0);
      const payloadLength = this.#buffer.readUInt32BE(4);
      if (headerLength > MAX_PTY_DAEMON_HEADER_BYTES) throw new Error("pty daemon frame header too large");
      if (payloadLength > MAX_PTY_DAEMON_PAYLOAD_BYTES) throw new Error("pty daemon frame payload too large");
      const frameLength = 8 + headerLength + payloadLength;
      if (this.#buffer.length < frameLength) break;
      const header = this.#buffer.subarray(8, 8 + headerLength);
      const payload = this.#buffer.subarray(8 + headerLength, frameLength);
      this.#buffer = this.#buffer.subarray(frameLength);
      frames.push({ message: parseHeader(header), payload: Buffer.from(payload) });
    }
    return frames;
  }
}

function parseHeader(header: Buffer): PtyDaemonMessage {
  try {
    const parsed = JSON.parse(header.toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || typeof (parsed as { type?: unknown }).type !== "string") {
      throw new Error("missing type");
    }
    return parsed as PtyDaemonMessage;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown";
    throw new Error(`invalid frame header: ${reason}`);
  }
}
