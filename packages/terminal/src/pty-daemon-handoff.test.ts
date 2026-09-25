import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PTY_DAEMON_HANDOFF_SNAPSHOT_VERSION,
  clearHandoffSnapshot,
  readHandoffSnapshot,
  writeHandoffSnapshot,
} from "./pty-daemon-handoff.js";

describe("PTY daemon handoff snapshots", () => {
  it("round-trips session metadata and replay bytes", () => {
    const snapshotPath = path.join(os.tmpdir(), `citadel-pty-handoff-${process.pid}-${Date.now()}.snap`);
    const replay = Buffer.from([0x00, 0xff, 0x80, 0x1b]);
    try {
      writeHandoffSnapshot(snapshotPath, {
        version: PTY_DAEMON_HANDOFF_SNAPSHOT_VERSION,
        writtenAt: "2026-06-05T00:00:00.000Z",
        sessions: [
          {
            sessionId: "pty-1",
            pid: 1234,
            fdIndex: 4,
            cwd: "/tmp",
            command: "bash",
            args: ["-l"],
            env: { TERM: "xterm-256color" },
            cols: 80,
            rows: 24,
            kind: "terminal",
            createdAt: "2026-06-05T00:00:00.000Z",
            lastOutputAt: "2026-06-05T00:00:01.000Z",
            replay,
          },
        ],
      });

      expect(fs.statSync(snapshotPath).mode & 0o777).toBe(0o600);
      const decoded = readHandoffSnapshot(snapshotPath);

      expect(decoded.sessions).toHaveLength(1);
      expect(decoded.sessions[0]).toEqual(expect.objectContaining({ sessionId: "pty-1", fdIndex: 4 }));
      expect(decoded.sessions[0]?.replay).toEqual(replay);
    } finally {
      clearHandoffSnapshot(snapshotPath);
    }
  });
});
