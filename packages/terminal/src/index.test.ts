import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  attachTerminalWebSocket,
  captureTmux,
  captureTmuxVisibleScreen,
  ensureTmuxSession,
  killTmuxSession,
  pasteText,
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

    sendKeys(sessionName, "\u001b[A");
    sendKeys(sessionName, "\r");
    await waitForCapture(sessionName, "printf terminal-smoke");

    resizePane(sessionName, 1000, 1);
    const captured = captureTmux(sessionName, 20);
    expect(captured).toContain("terminal-smoke");
    expect(captureTmux(sessionName, 5).split("\n")[0]?.length ?? 0).toBeLessThanOrEqual(400);

    killTmuxSession(sessionName);
    expect(tmuxSessionExists(sessionName)).toBe(false);
  });

  it("supports control input and multi-line paste through tmux", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-terminal-"));
    dirs.push(cwd);
    const sessionName = `citadel_control_test_${Date.now().toString(36)}`;
    sessions.push(sessionName);
    await ensureTmuxSession({
      sessionName,
      cwd,
      command: "bash",
      args: ["--noprofile", "--norc"],
    });

    sendKeys(sessionName, "trap 'echo INTERRUPTED' INT; sleep 10");
    sendKeys(sessionName, "\r");
    sendKeys(sessionName, "\u0003");
    await waitForCapture(sessionName, "INTERRUPTED");

    sendKeys(sessionName, "cat > pasted.txt");
    sendKeys(sessionName, "\r");
    pasteText(sessionName, "alpha\nbeta\n");
    sendKeys(sessionName, "\u0004");
    await waitForCapture(sessionName, "$");

    expect(fs.readFileSync(path.join(cwd, "pasted.txt"), "utf8")).toBe("alpha\nbeta\n");
  });

  it("captures active alternate-screen output when an interactive program switches screens", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-terminal-"));
    dirs.push(cwd);
    const sessionName = `citadel_alt_test_${Date.now().toString(36)}`;
    sessions.push(sessionName);
    await ensureTmuxSession({
      sessionName,
      cwd,
      command: "bash",
      args: ["--noprofile", "--norc"],
    });

    sendKeys(sessionName, "printf '\\033[?1049hALTSCREEN'; sleep 1; printf '\\033[?1049l'");
    sendKeys(sessionName, "\r");
    await waitForVisibleScreen(sessionName, "ALTSCREEN");

    expect(captureTmuxVisibleScreen(sessionName, 20)).toContain("ALTSCREEN");
  });

  it("bridges alternate-screen output over WebSocket", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-terminal-"));
    dirs.push(cwd);
    const sessionName = `citadel_ws_alt_${Date.now().toString(36)}`;
    sessions.push(sessionName);
    await ensureTmuxSession({
      sessionName,
      cwd,
      command: "bash",
      args: ["--noprofile", "--norc"],
    });
    const server = http.createServer();
    attachTerminalWebSocket(server, (id) => (id === "alt" ? sessionName : null));
    await listen(server);
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP test server address");
      const ws = new WebSocket(`ws://127.0.0.1:${address.port}/terminal/alt`);
      await waitForOpen(ws);

      ws.send(JSON.stringify({ type: "input", data: "printf '\\033[?1049hWSALT'; sleep 1; printf '\\033[?1049l'" }));
      ws.send(JSON.stringify({ type: "input", data: "\r" }));
      await waitForWebSocketOutput(ws, "WSALT");

      ws.close();
      await waitForClose(ws);
    } finally {
      await closeServer(server);
    }
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

      ws.send(JSON.stringify({ type: "input", data: "cat > websocket-paste.txt" }));
      ws.send(JSON.stringify({ type: "input", data: "\r" }));
      ws.send(JSON.stringify({ type: "paste", data: "one\ntwo\n" }));
      ws.send(JSON.stringify({ type: "input", data: "\u0004" }));
      await waitForFile(path.join(cwd, "websocket-paste.txt"), "one\ntwo\n");

      ws.send(JSON.stringify({ type: "resize", cols: 90, rows: 24 }));
      await waitForCapture(sessionName, "websocket-smoke");

      ws.close();
      await waitForClose(ws);
    } finally {
      await closeServer(server);
    }
  });

  it("keeps WebSocket output isolated across sessions and supports reconnect scrollback", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-terminal-"));
    dirs.push(cwd);
    const sessionA = `citadel_iso_a_${Date.now().toString(36)}`;
    const sessionB = `citadel_iso_b_${Date.now().toString(36)}`;
    sessions.push(sessionA, sessionB);
    await ensureTmuxSession({ sessionName: sessionA, cwd, command: "bash", args: ["--noprofile", "--norc"] });
    await ensureTmuxSession({ sessionName: sessionB, cwd, command: "bash", args: ["--noprofile", "--norc"] });
    const server = http.createServer();
    attachTerminalWebSocket(server, (id) => (id === "a" ? sessionA : id === "b" ? sessionB : null));
    await listen(server);
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP test server address");
      const wsA = new WebSocket(`ws://127.0.0.1:${address.port}/terminal/a`);
      const wsB = new WebSocket(`ws://127.0.0.1:${address.port}/terminal/b`);
      await Promise.all([waitForOpen(wsA), waitForOpen(wsB)]);

      wsA.send(
        JSON.stringify({
          type: "input",
          data: "printf 'session-a-only\\n'; for i in $(seq 1 120); do echo long-a-$i; done",
        }),
      );
      wsA.send(JSON.stringify({ type: "input", data: "\r" }));
      wsB.send(JSON.stringify({ type: "input", data: "printf session-b-only" }));
      wsB.send(JSON.stringify({ type: "input", data: "\r" }));

      await waitForWebSocketOutput(wsA, "long-a-120");
      await waitForWebSocketOutput(wsB, "session-b-only");
      expect(captureTmux(sessionB, 40)).not.toContain("session-a-only");
      expect(captureTmux(sessionA, 1000)).toContain("long-a-120");

      wsA.close();
      await waitForClose(wsA);
      const reconnectA = new WebSocket(`ws://127.0.0.1:${address.port}/terminal/a`);
      const reconnectOutput = waitForWebSocketOutput(reconnectA, "long-a-120");
      await waitForOpen(reconnectA);
      await reconnectOutput;

      reconnectA.close();
      wsB.close();
      await Promise.all([waitForClose(reconnectA), waitForClose(wsB)]);
    } finally {
      await closeServer(server);
    }
  }, 15000);
});

async function waitForCapture(sessionName: string, expected: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const output = captureTmux(sessionName, 20);
    if (output.includes(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${expected}`);
}

async function waitForVisibleScreen(sessionName: string, expected: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const output = captureTmuxVisibleScreen(sessionName, 20);
    if (output.includes(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for visible screen ${expected}`);
}

async function waitForFile(filePath: string, expected: string) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (fs.existsSync(filePath) && fs.readFileSync(filePath, "utf8") === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
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
