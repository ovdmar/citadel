import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { connectPtyDaemonClient } from "./pty-daemon-client.js";
import { PtyDaemonServer } from "./pty-daemon-server.js";
import { type PtyLike, PtySessionStore } from "./pty-daemon-store.js";

const dirs: string[] = [];
const servers: PtyDaemonServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("PTY daemon Unix socket client/server", () => {
  it("opens, lists, subscribes, writes, resizes, captures, and closes PTY sessions", async () => {
    const fake = new FakePty();
    const { server, socketPath } = await startServer(fake);
    const client = await connectPtyDaemonClient({ socketPath });
    const output: string[] = [];

    const opened = await client.open({
      sessionId: "pty-1",
      cwd: "/tmp/workspace",
      command: "bash",
      args: ["-l"],
      env: { TERM: "xterm-256color" },
      cols: 80,
      rows: 24,
      kind: "terminal",
    });
    expect(opened.sessionId).toBe("pty-1");
    expect(fs.statSync(socketPath).mode & 0o777).toBe(0o600);

    const unsubscribe = await client.subscribe("pty-1", {
      replay: true,
      onOutput: (chunk) => output.push(chunk.toString("utf8")),
    });
    fake.emitData("READY\n");
    await waitFor(() => output.join("").includes("READY"));

    client.input("pty-1", Buffer.from("\u0003"));
    await waitFor(() => fake.writes.length === 1);
    expect(fake.writes).toEqual(["\u0003"]);

    client.resize("pty-1", 1000, 1);
    await waitFor(() => fake.resizes.length === 1);
    expect(fake.resizes).toEqual([{ cols: 400, rows: 5 }]);

    const list = await client.list();
    expect(list).toEqual([expect.objectContaining({ sessionId: "pty-1", cols: 400, rows: 5 })]);

    const capture = await client.capture("pty-1", { lines: 10, maxChars: 1000 });
    expect(capture).toEqual({
      ok: true,
      sessionId: "pty-1",
      text: "READY",
      charCount: 5,
      truncated: false,
    });

    unsubscribe();
    client.closeSession("pty-1");
    await waitFor(() => fake.kills.length === 1);
    expect(fake.kills).toEqual(["SIGHUP"]);

    client.dispose();
    await server.close();
  });

  it("lets a new client adopt an existing daemon-owned PTY session with replay", async () => {
    const fake = new FakePty();
    const { socketPath } = await startServer(fake);
    const firstClient = await connectPtyDaemonClient({ socketPath });
    await firstClient.open({
      sessionId: "pty-1",
      cwd: "/tmp/workspace",
      command: "bash",
      args: ["-l"],
      env: {},
      cols: 80,
      rows: 24,
      kind: "terminal",
    });
    fake.emitData("before-reconnect\n");
    firstClient.dispose();

    const secondClient = await connectPtyDaemonClient({ socketPath });
    expect(await secondClient.list()).toEqual([expect.objectContaining({ sessionId: "pty-1" })]);

    const output: string[] = [];
    await secondClient.subscribe("pty-1", {
      replay: true,
      onOutput: (chunk) => output.push(chunk.toString("utf8")),
    });
    await waitFor(() => output.join("").includes("before-reconnect"));

    secondClient.dispose();
  });
});

async function startServer(fake: FakePty) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-pty-daemon-"));
  dirs.push(dir);
  const socketPath = path.join(dir, "pty.sock");
  const server = new PtyDaemonServer({
    socketPath,
    store: new PtySessionStore({ replayLimitBytes: 1024, spawnPty: () => fake }),
  });
  servers.push(server);
  await server.start();
  return { server, socketPath };
}

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

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}
