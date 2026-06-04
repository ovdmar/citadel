import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { type PtyLike, PtySessionStore } from "./pty-daemon-store.js";

describe("PTY daemon session store", () => {
  it("opens sessions, writes input bytes, resizes, captures replay, and closes", () => {
    const fake = new FakePty();
    const store = new PtySessionStore({
      replayLimitBytes: 64,
      spawnPty: () => fake,
    });

    const opened = store.open({
      sessionId: "pty-1",
      cwd: "/tmp/workspace",
      command: "bash",
      args: ["-l"],
      env: { TERM: "xterm-256color" },
      cols: 80,
      rows: 24,
      kind: "terminal",
    });

    expect(opened.pid).toBe(fake.pid);
    expect(store.list()).toEqual([
      expect.objectContaining({
        sessionId: "pty-1",
        cwd: "/tmp/workspace",
        command: "bash",
        args: ["-l"],
        cols: 80,
        rows: 24,
        kind: "terminal",
      }),
    ]);

    store.input("pty-1", Buffer.from([0x03]));
    expect(fake.writes).toEqual(["\u0003"]);

    store.resize("pty-1", 120, 40);
    expect(fake.resizes).toEqual([{ cols: 120, rows: 40 }]);
    expect(store.list()[0]).toEqual(expect.objectContaining({ cols: 120, rows: 40 }));

    fake.emitData("hello\n");
    fake.emitData("world\n");
    expect(store.capture("pty-1", { lines: 2, maxChars: 64 })).toEqual({
      ok: true,
      text: "hello\nworld",
      sessionId: "pty-1",
      charCount: 11,
      truncated: false,
    });

    store.close("pty-1");
    expect(fake.kills).toEqual(["SIGHUP"]);
  });

  it("replays bounded output to new subscribers and keeps subscribers isolated", () => {
    const fake = new FakePty();
    const store = new PtySessionStore({
      replayLimitBytes: 10,
      spawnPty: () => fake,
    });
    store.open({
      sessionId: "pty-1",
      cwd: "/tmp",
      command: "bash",
      args: [],
      env: {},
      cols: 80,
      rows: 24,
      kind: "terminal",
    });
    fake.emitData("first-line\nsecond-line\n");

    const replayed: string[] = [];
    const live: string[] = [];
    const unsubscribeReplay = store.subscribe("pty-1", {
      replay: true,
      onOutput: (chunk) => replayed.push(chunk.toString("utf8")),
    });
    const unsubscribeLive = store.subscribe("pty-1", {
      replay: false,
      onOutput: (chunk) => live.push(chunk.toString("utf8")),
    });

    expect(replayed.join("")).toBe("cond-line\n");
    expect(live).toEqual([]);

    fake.emitData("tail\n");
    unsubscribeReplay();
    fake.emitData("after-unsubscribe\n");

    expect(replayed.join("")).toBe("cond-line\ntail\n");
    expect(live.join("")).toBe("tail\nafter-unsubscribe\n");
    unsubscribeLive();
  });

  it("reports missing sessions without creating side effects", () => {
    const store = new PtySessionStore({ spawnPty: () => new FakePty() });

    expect(() => store.input("missing", Buffer.from("x"))).toThrow(/pty_session_missing/);
    expect(() => store.resize("missing", 80, 24)).toThrow(/pty_session_missing/);
    expect(store.capture("missing")).toEqual({ ok: false, error: "pty_session_missing" });
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
