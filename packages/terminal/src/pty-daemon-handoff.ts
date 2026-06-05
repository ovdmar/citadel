import fs from "node:fs";
import { MAX_PTY_DAEMON_HEADER_BYTES, MAX_PTY_DAEMON_PAYLOAD_BYTES } from "./pty-daemon-protocol.js";

export const PTY_DAEMON_HANDOFF_SNAPSHOT_VERSION = 1;

type HandoffHeaderFrame = {
  type: "handoff-header";
  version: typeof PTY_DAEMON_HANDOFF_SNAPSHOT_VERSION;
  writtenAt: string;
  sessionCount: number;
};

type HandoffSessionFrame = {
  type: "handoff-session";
  sessionId: string;
  pid: number;
  fdIndex: number;
  cwd: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cols: number;
  rows: number;
  kind: string;
  createdAt: string;
  lastOutputAt: string | null;
};

export type PtyDaemonHandoffSession = Omit<HandoffSessionFrame, "type"> & {
  replay: Buffer;
};

export type PtyDaemonHandoffSnapshot = {
  version: typeof PTY_DAEMON_HANDOFF_SNAPSHOT_VERSION;
  writtenAt: string;
  sessions: PtyDaemonHandoffSession[];
};

export type PtyDaemonHandoffMessage =
  | { type: "upgrade-ack"; successorPid: number }
  | { type: "upgrade-nak"; reason: string };

export function writeHandoffSnapshot(path: string, snapshot: PtyDaemonHandoffSnapshot): void {
  const tmp = `${path}.tmp`;
  const header: HandoffHeaderFrame = {
    type: "handoff-header",
    version: snapshot.version,
    writtenAt: snapshot.writtenAt,
    sessionCount: snapshot.sessions.length,
  };
  const frames = [encodeSnapshotFrame(header)];
  for (const session of snapshot.sessions) {
    const { replay, ...message } = session;
    frames.push(encodeSnapshotFrame({ type: "handoff-session", ...message }, replay));
  }
  fs.writeFileSync(tmp, Buffer.concat(frames), { mode: 0o600 });
  fs.renameSync(tmp, path);
}

export function readHandoffSnapshot(path: string): PtyDaemonHandoffSnapshot {
  const frames = decodeSnapshotFrames(fs.readFileSync(path));
  const first = frames[0]?.message as Partial<HandoffHeaderFrame> | undefined;
  if (!first || first.type !== "handoff-header") throw new Error("handoff snapshot missing header");
  if (first.version !== PTY_DAEMON_HANDOFF_SNAPSHOT_VERSION) {
    throw new Error(`unsupported handoff snapshot version ${String(first.version)}`);
  }
  if (typeof first.writtenAt !== "string") throw new Error("handoff snapshot has invalid writtenAt");
  if (typeof first.sessionCount !== "number" || first.sessionCount !== frames.length - 1) {
    throw new Error("handoff snapshot session count mismatch");
  }
  const sessions: PtyDaemonHandoffSession[] = [];
  for (let i = 1; i < frames.length; i += 1) {
    const frame = frames[i];
    if (!frame) continue;
    const message = frame.message as Partial<HandoffSessionFrame>;
    if (!isHandoffSessionFrame(message)) throw new Error(`handoff snapshot has invalid session frame ${i}`);
    sessions.push({ ...message, replay: frame.payload });
  }
  return {
    version: first.version,
    writtenAt: first.writtenAt,
    sessions,
  };
}

export function clearHandoffSnapshot(path: string): void {
  try {
    fs.unlinkSync(path);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
}

function encodeSnapshotFrame(message: Record<string, unknown>, payload: Buffer = Buffer.alloc(0)): Buffer {
  const header = Buffer.from(JSON.stringify(message), "utf8");
  if (header.length > MAX_PTY_DAEMON_HEADER_BYTES) throw new Error("handoff snapshot header too large");
  if (payload.length > MAX_PTY_DAEMON_PAYLOAD_BYTES) throw new Error("handoff snapshot payload too large");
  const prefix = Buffer.alloc(8);
  prefix.writeUInt32BE(header.length, 0);
  prefix.writeUInt32BE(payload.length, 4);
  return Buffer.concat([prefix, header, payload]);
}

function decodeSnapshotFrames(raw: Buffer): Array<{ message: unknown; payload: Buffer }> {
  const frames: Array<{ message: unknown; payload: Buffer }> = [];
  let offset = 0;
  while (offset < raw.length) {
    if (raw.length - offset < 8) throw new Error("truncated handoff snapshot frame prefix");
    const headerLength = raw.readUInt32BE(offset);
    const payloadLength = raw.readUInt32BE(offset + 4);
    if (headerLength > MAX_PTY_DAEMON_HEADER_BYTES) throw new Error("handoff snapshot header too large");
    if (payloadLength > MAX_PTY_DAEMON_PAYLOAD_BYTES) throw new Error("handoff snapshot payload too large");
    const headerStart = offset + 8;
    const payloadStart = headerStart + headerLength;
    const frameEnd = payloadStart + payloadLength;
    if (frameEnd > raw.length) throw new Error("truncated handoff snapshot frame");
    frames.push({
      message: JSON.parse(raw.subarray(headerStart, payloadStart).toString("utf8")) as unknown,
      payload: Buffer.from(raw.subarray(payloadStart, frameEnd)),
    });
    offset = frameEnd;
  }
  return frames;
}

function isHandoffSessionFrame(value: Partial<HandoffSessionFrame>): value is HandoffSessionFrame {
  return (
    value.type === "handoff-session" &&
    typeof value.sessionId === "string" &&
    typeof value.pid === "number" &&
    typeof value.fdIndex === "number" &&
    typeof value.cwd === "string" &&
    typeof value.command === "string" &&
    Array.isArray(value.args) &&
    value.args.every((item) => typeof item === "string") &&
    typeof value.env === "object" &&
    value.env !== null &&
    typeof value.cols === "number" &&
    typeof value.rows === "number" &&
    typeof value.kind === "string" &&
    typeof value.createdAt === "string" &&
    (value.lastOutputAt === null || typeof value.lastOutputAt === "string")
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
