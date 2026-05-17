import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  attachTerminalWebSocket,
  captureTmux,
  ensureTmuxSession,
  killTmuxSession,
  resizePane,
  sendKeys,
  tmuxSessionExists,
} from "./index.js";

const sessions: string[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const session of sessions.splice(0)) killTmuxSession(session);
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("tmux terminal gateway helpers", () => {
  it("creates durable sessions, sends input, captures output, resizes, and cleans up", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-terminal-"));
    dirs.push(cwd);
    const sessionName = `citadel_test_${Date.now().toString(36)}`;
    sessions.push(sessionName);

    const session = await ensureTmuxSession({
      sessionName,
      cwd,
      command: "bash",
      args: ["--noprofile", "--norc"],
    });

    expect(session.tmuxSessionName).toBe(sessionName);
    expect(session.tmuxSessionId).toMatch(/^\$/);
    expect(tmuxSessionExists(sessionName)).toBe(true);

    sendKeys(sessionName, "printf terminal-smoke");
    sendKeys(sessionName, "\n");
    await waitForCapture(sessionName, "terminal-smoke");

    resizePane(sessionName, 100, 30);
    const captured = captureTmux(sessionName, 20);
    expect(captured).toContain("terminal-smoke");

    killTmuxSession(sessionName);
    expect(tmuxSessionExists(sessionName)).toBe(false);
  });

  it("bridges tmux sessions over WebSocket input, output, and resize messages", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-terminal-"));
    dirs.push(cwd);
    const sessionName = `citadel_ws_test_${Date.now().toString(36)}`;
    sessions.push(sessionName);
    await ensureTmuxSession({
      sessionName,
      cwd,
      command: "bash",
      args: ["--noprofile", "--norc"],
    });
    const server = http.createServer();
    attachTerminalWebSocket(server, (id) => (id === "sess_test" ? sessionName : null));
    await listen(server);
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP test server address");
      const ws = new WebSocket(`ws://127.0.0.1:${address.port}/terminal/sess_test`);
      await waitForOpen(ws);

      ws.send(JSON.stringify({ type: "input", data: "printf websocket-smoke" }));
      ws.send(JSON.stringify({ type: "input", data: "\r" }));
      await waitForWebSocketOutput(ws, "websocket-smoke");

      ws.send(JSON.stringify({ type: "resize", cols: 90, rows: 24 }));
      await waitForCapture(sessionName, "websocket-smoke");

      ws.close();
      await waitForClose(ws);
    } finally {
      await closeServer(server);
    }
  });
});

async function waitForCapture(sessionName: string, expected: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const output = captureTmux(sessionName, 20);
    if (output.includes(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${expected}`);
}

function listen(server: http.Server) {
  return new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function closeServer(server: http.Server) {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function waitForOpen(ws: WebSocket) {
  return new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
}

function waitForClose(ws: WebSocket) {
  return new Promise<void>((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    ws.once("close", () => resolve());
  });
}

function waitForWebSocketOutput(ws: WebSocket, expected: string) {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for WebSocket output ${expected}`));
    }, 5000);
    const onMessage = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString()) as { type?: string; data?: string };
      if (message.type === "output" && message.data?.includes(expected)) {
        cleanup();
        resolve();
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      ws.off("message", onMessage);
      ws.off("error", onError);
    };
    ws.on("message", onMessage);
    ws.once("error", onError);
  });
}
