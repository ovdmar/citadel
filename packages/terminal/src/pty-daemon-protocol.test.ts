import { describe, expect, it } from "vitest";
import {
  MAX_PTY_DAEMON_HEADER_BYTES,
  MAX_PTY_DAEMON_PAYLOAD_BYTES,
  PtyDaemonFrameReader,
  encodePtyDaemonFrame,
} from "./pty-daemon-protocol.js";

describe("PTY daemon protocol framing", () => {
  it("round-trips JSON headers with optional binary payloads", () => {
    const frame = encodePtyDaemonFrame(
      { type: "input", requestId: "req-1", sessionId: "pty-1" },
      Buffer.from([0x00, 0x03, 0xff]),
    );
    const reader = new PtyDaemonFrameReader();
    const [firstHalf, secondHalf] = splitBuffer(frame);

    expect(reader.push(firstHalf)).toEqual([]);
    const decoded = reader.push(secondHalf);

    expect(decoded).toHaveLength(1);
    expect(decoded[0]?.message).toEqual({ type: "input", requestId: "req-1", sessionId: "pty-1" });
    expect(decoded[0]?.payload).toEqual(Buffer.from([0x00, 0x03, 0xff]));
  });

  it("decodes multiple frames pushed in one chunk", () => {
    const first = encodePtyDaemonFrame({ type: "ping", requestId: "one" });
    const second = encodePtyDaemonFrame({ type: "ping", requestId: "two" }, Buffer.from("payload"));
    const reader = new PtyDaemonFrameReader();

    const decoded = reader.push(Buffer.concat([first, second]));

    expect(decoded.map((frame) => frame.message)).toEqual([
      { type: "ping", requestId: "one" },
      { type: "ping", requestId: "two" },
    ]);
    expect(decoded[1]?.payload.toString("utf8")).toBe("payload");
  });

  it("rejects oversized headers and payloads", () => {
    const reader = new PtyDaemonFrameReader();
    const badHeader = Buffer.alloc(8);
    badHeader.writeUInt32BE(MAX_PTY_DAEMON_HEADER_BYTES + 1, 0);
    badHeader.writeUInt32BE(0, 4);

    expect(() => reader.push(badHeader)).toThrow(/header too large/);

    const payloadReader = new PtyDaemonFrameReader();
    const badPayload = Buffer.alloc(8);
    badPayload.writeUInt32BE(2, 0);
    badPayload.writeUInt32BE(MAX_PTY_DAEMON_PAYLOAD_BYTES + 1, 4);
    expect(() => payloadReader.push(badPayload)).toThrow(/payload too large/);
  });

  it("rejects malformed JSON headers", () => {
    const raw = Buffer.from("{nope", "utf8");
    const prefix = Buffer.alloc(8);
    prefix.writeUInt32BE(raw.length, 0);
    prefix.writeUInt32BE(0, 4);

    const reader = new PtyDaemonFrameReader();
    expect(() => reader.push(Buffer.concat([prefix, raw]))).toThrow(/invalid frame header/);
  });
});

function splitBuffer(buffer: Buffer): [Buffer, Buffer] {
  const midpoint = Math.max(1, Math.floor(buffer.length / 2));
  return [buffer.subarray(0, midpoint), buffer.subarray(midpoint)];
}
