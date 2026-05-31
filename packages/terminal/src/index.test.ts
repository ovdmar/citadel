import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  agentLiveSentinelPath,
  attachTerminalWebSocket,
  captureTmux,
  captureTmuxVisibleScreen,
  captureTranscript,
  clampTerminalPtySize,
  ensureTmuxExtendedKeys,
  ensureTmuxSession,
  ensureTmuxSessionRaw,
  isAgentLive,
  killTmuxSession,
  parseTerminalSocketMessage,
  pasteText,
  pipeBackgroundSessionToLog,
  resizePane,
  sendKeys,
  shellQuote,
  stopBackgroundSessionPipe,
  submitPrompt,
  tmuxSessionExists,
} from "./index.js";
import { hasCollapsedPasteMarker } from "./submit-prompt.js";

const sessions: string[] = [];
const socketSessions: Array<{ sessionName: string; socketName: string }> = [];
const dirs: string[] = [];

afterEach(() => {
  for (const session of sessions.splice(0)) killTmuxSession(session);
  for (const { sessionName, socketName } of socketSessions.splice(0)) {
    killTmuxSession(sessionName, socketName);
    try {
      execFileSync("tmux", ["-L", socketName, "kill-server"], { stdio: "ignore" });
    } catch {
      /* server already gone */
    }
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("tmux terminal gateway helpers", () => {
  it("recognizes collapsed paste markers from Claude Code and Codex", () => {
    expect(hasCollapsedPasteMarker("[Pasted text #1 +101 lines]")).toBe(true);
    expect(hasCollapsedPasteMarker("[Pasted Content 3298 chars]")).toBe(true);
    expect(hasCollapsedPasteMarker("Pasted Content 3298 chars")).toBe(false);
  });

  it("parses PTY WebSocket messages defensively and clamps terminal sizes", () => {
    expect(parseTerminalSocketMessage(JSON.stringify({ type: "input", data: "ok" }))).toEqual({
      type: "input",
      data: "ok",
    });
    expect(parseTerminalSocketMessage("{nope")).toBeNull();
    expect(parseTerminalSocketMessage(JSON.stringify({ data: "missing-type" }))).toBeNull();
    expect(clampTerminalPtySize(1000, 1)).toEqual({ cols: 400, rows: 5 });
  });

  it("creates durable sessions, sends input, captures output, resizes, and cleans up", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-terminal-"));
    dirs.push(cwd);
    const sessionName = `citadel_test_${Date.now().toString(36)}`;
    sessions.push(sessionName);

    const session = await ensureTmuxSession({
      sessionName,
      cwd,
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

  it("keeps same-named sessions isolated across tmux sockets", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-terminal-"));
    dirs.push(cwd);
    const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const sessionName = `citadel_socket_${suffix}`;
    const socketA = `citadel_test_a_${suffix}`;
    const socketB = `citadel_test_b_${suffix}`;
    socketSessions.push({ sessionName, socketName: socketA });

    const session = await ensureTmuxSession({ sessionName, cwd, socketName: socketA });

    expect(session.tmuxSocketName).toBe(socketA);
    expect(tmuxSessionExists(sessionName, socketA)).toBe(true);
    expect(tmuxSessionExists(sessionName, socketB)).toBe(false);

    sendKeys(sessionName, "printf socket-a", socketA);
    sendKeys(sessionName, "\r", socketA);
    await waitForCapture(sessionName, "socket-a", socketA);
    expect(captureTmux(sessionName, 20, socketA)).toContain("socket-a");
  });

  it("enables tmux extended keys for modified terminal shortcuts", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-terminal-"));
    dirs.push(cwd);
    const sessionName = `citadel_extkeys_${Date.now().toString(36)}`;
    sessions.push(sessionName);
    await ensureTmuxSession({
      sessionName,
      cwd,
    });

    ensureTmuxExtendedKeys();

    const extendedKeys = execTmux(["show-options", "-s", "-g", "extended-keys"]);
    const extendedKeysFormat = maybeExecTmux(["show-options", "-s", "-g", "extended-keys-format"]);
    const terminalFeatures = execTmux(["show-options", "-s", "-g", "terminal-features"]);
    const historyLimit = execTmux(["show-options", "-g", "history-limit"]);
    const mouse = execTmux(["show-options", "-g", "mouse"]);
    const clipboard = execTmux(["show-options", "-g", "set-clipboard"]);
    expect(extendedKeys).toContain("extended-keys on");
    if (extendedKeysFormat) expect(extendedKeysFormat).toContain("extended-keys-format csi-u");
    expect(terminalFeatures).toMatch(/xterm\*.*extkeys/);
    expect(historyLimit).toContain("history-limit 5000");
    expect(mouse).toContain("mouse on");
    expect(clipboard).toContain("set-clipboard on");
  });

  it("submitPrompt pastes the prompt and presses Enter so the runtime actually executes it", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-terminal-"));
    dirs.push(cwd);
    const sessionName = `citadel_submit_prompt_${Date.now().toString(36)}`;
    sessions.push(sessionName);
    await ensureTmuxSession({
      sessionName,
      cwd,
    });

    // Simulates Claude Code's input box: a `read` waits for an entire line. If
    // submitPrompt only typed characters, the read would never resolve. We
    // assert the read DID resolve, proving Enter was submitted.
    sendKeys(sessionName, "read line && printf 'GOT:%s\\n' \"$line\"");
    sendKeys(sessionName, "\r");
    await waitForCapture(sessionName, "$");

    // skipVerification: bash's `read` doesn't render a TUI input box, so the
    // post-paste "is the snippet in the input region" check would always fail.
    // The submission-worked assertion below is the real test for this path.
    const result = await submitPrompt(sessionName, "hello-claude", {
      waitForReadyMs: 200,
      submitDelayMs: 50,
      skipVerification: true,
    });
    expect(result.ok).toBe(true);
    await waitForCapture(sessionName, "GOT:hello-claude");
  });

  it("submitPrompt strips trailing newlines so the in-paste LF can't pre-empt the explicit Enter", async () => {
    // Regression: prompts arriving with trailing whitespace from the MCP layer
    // would paste an LF into the runtime BEFORE the explicit Enter fired. On
    // Claude Code that LF was committed as a newline-in-input rather than a
    // submit, leaving the typed text in the input box waiting for a manual
    // Enter from the user. With the fix we always strip trailing newlines
    // before pasting and only ever submit via the separate Enter send-keys.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-terminal-"));
    dirs.push(cwd);
    const sessionName = `citadel_submit_prompt_trim_${Date.now().toString(36)}`;
    sessions.push(sessionName);
    await ensureTmuxSession({
      sessionName,
      cwd,
    });
    sendKeys(sessionName, "read line && printf 'TRIMMED:%s.\\n' \"$line\"");
    sendKeys(sessionName, "\r");
    await waitForCapture(sessionName, "$");

    const result = await submitPrompt(sessionName, "trim-me\n\n", {
      waitForReadyMs: 200,
      submitDelayMs: 400,
      skipVerification: true,
    });
    expect(result.ok).toBe(true);
    // If the trailing LF had been left in the paste it would have been
    // consumed by `read` and the suffix "." would never appear.
    await waitForCapture(sessionName, "TRIMMED:trim-me.");
  });

  it("submitPrompt reports tmux_session_missing when the session has gone away", async () => {
    const result = await submitPrompt("citadel_nonexistent_session", "test");
    expect(result).toEqual({ ok: false, error: "tmux_session_missing" });
  });

  it("captureTranscript returns bounded text plus session metadata", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-terminal-"));
    dirs.push(cwd);
    const sessionName = `citadel_transcript_${Date.now().toString(36)}`;
    sessions.push(sessionName);
    await ensureTmuxSession({
      sessionName,
      cwd,
    });
    sendKeys(sessionName, "printf 'transcript-line\\n'");
    sendKeys(sessionName, "\r");
    await waitForCapture(sessionName, "transcript-line");

    const transcript = captureTranscript(sessionName, { lines: 50, maxChars: 4000 });
    expect(transcript.ok).toBe(true);
    if (transcript.ok) {
      expect(transcript.text).toContain("transcript-line");
      expect(transcript.charCount).toBeLessThanOrEqual(4000);
      expect(transcript.sessionName).toBe(sessionName);
    }

    const truncated = captureTranscript(sessionName, { maxChars: 256 });
    expect(truncated.ok).toBe(true);
    if (truncated.ok) expect(truncated.text.length).toBeLessThanOrEqual(256);

    const missing = captureTranscript("citadel_missing_session_xyz");
    expect(missing).toEqual({ ok: false, error: "tmux_session_missing" });
  });

  it("supports control input and multi-line paste through tmux", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-terminal-"));
    dirs.push(cwd);
    const sessionName = `citadel_control_test_${Date.now().toString(36)}`;
    sessions.push(sessionName);
    await ensureTmuxSession({
      sessionName,
      cwd,
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

    await waitFor(() => fs.existsSync(path.join(cwd, "pasted.txt")), 5000);
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
    });
    const server = http.createServer();
    attachTerminalWebSocket(server, (id) => (id === "alt" ? sessionName : null));
    await listen(server);
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP test server address");
      const ws = new WebSocket(`ws://127.0.0.1:${address.port}/terminal/alt`);
      await waitForOpen(ws);

      sendWsInput(ws, "printf '\\033[?1049hWSALT'; sleep 1; printf '\\033[?1049l'");
      sendWsInput(ws, "\r");
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
    });
    const server = http.createServer();
    attachTerminalWebSocket(server, (id) => (id === "sess_test" ? sessionName : null));
    await listen(server);
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP test server address");
      const ws = new WebSocket(`ws://127.0.0.1:${address.port}/terminal/sess_test`);
      await waitForOpen(ws);

      const invalidMessageError = waitForWebSocketOutput(ws, "invalid_message", "error");
      ws.send("{not-json");
      await invalidMessageError;

      const streamedOutput = waitForWebSocketOutput(ws, "websocket-smoke", "binary");
      sendWsInput(
        ws,
        "printf 'websocket-smoke\\n'; cat <<'CITADEL_EOF' > websocket-paste.txt\none\ntwo\nCITADEL_EOF\n",
      );
      await waitForWebSocketOutput(ws, "websocket-smoke");
      await streamedOutput;
      await waitForFile(path.join(cwd, "websocket-paste.txt"), "one\ntwo\n");

      ws.send(JSON.stringify({ type: "resize", cols: 90, rows: 24 }));
      await waitForCapture(sessionName, "websocket-smoke");

      ws.close();
      await waitForClose(ws);
    } finally {
      await closeServer(server);
    }
  }, 15000);

  it("sends WebSocket input control messages as literal pane input", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-terminal-"));
    dirs.push(cwd);
    const sessionName = `citadel_ws_literal_${Date.now().toString(36)}`;
    sessions.push(sessionName);
    await ensureTmuxSession({ sessionName, cwd });
    const readerPath = path.join(cwd, "read-byte.py");
    fs.writeFileSync(
      readerPath,
      [
        "import sys, tty, termios, select, time",
        "fd=sys.stdin.fileno()",
        "old=termios.tcgetattr(fd)",
        "tty.setraw(fd)",
        "print('READY', flush=True)",
        "data=b''",
        "end=time.time()+2",
        "while time.time()<end:",
        "    r,_,_=select.select([sys.stdin], [], [], 0.1)",
        "    if r: data += sys.stdin.buffer.read(1)",
        "print('BYTES:'+data.hex(), flush=True)",
        "termios.tcsetattr(fd, termios.TCSADRAIN, old)",
      ].join("\n"),
    );
    sendKeys(sessionName, `python3 ${shellQuote(readerPath)}`);
    sendKeys(sessionName, "\r");
    await waitForCapture(sessionName, "READY");

    const server = http.createServer();
    attachTerminalWebSocket(server, (id) => (id === "literal" ? sessionName : null));
    await listen(server);
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP test server address");
      const ws = new WebSocket(`ws://127.0.0.1:${address.port}/terminal/literal`);
      await waitForOpen(ws);

      ws.send(JSON.stringify({ type: "input", data: "\n" }));

      await waitForCapture(sessionName, "BYTES:0a");
      ws.close();
      await waitForClose(ws);
    } finally {
      await closeServer(server);
    }
  }, 15000);

  it("tears down attached PTY viewers before HTTP server close waits on upgraded sockets", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-terminal-"));
    dirs.push(cwd);
    const sessionName = `citadel_ws_shutdown_${Date.now().toString(36)}`;
    sessions.push(sessionName);
    await ensureTmuxSession({
      sessionName,
      cwd,
    });
    const server = http.createServer();
    attachTerminalWebSocket(server, (id) => (id === "shutdown" ? sessionName : null));
    await listen(server);

    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP test server address");
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/terminal/shutdown`);
    await waitForOpen(ws);

    await closeServer(server);
    await waitForClose(ws);
    expect(tmuxSessionExists(sessionName)).toBe(true);
  }, 15000);

  // Regression test for the Ctrl+C-leaves-unusable-terminal complaint.
  // We stand in for a real agent with a loop that traps SIGINT and exits 0,
  // so we can "kill" it via Ctrl+C the way a user would Ctrl+C Claude Code.
  // After it dies, the pane must drop back to an interactive login shell
  // rooted at the workspace cwd, and the sentinel that gates session status
  // detection must be cleared.

  it("keeps WebSocket output isolated across sessions and supports reconnect scrollback", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-terminal-"));
    dirs.push(cwd);
    const sessionA = `citadel_iso_a_${Date.now().toString(36)}`;
    const sessionB = `citadel_iso_b_${Date.now().toString(36)}`;
    sessions.push(sessionA, sessionB);
    await ensureTmuxSession({ sessionName: sessionA, cwd });
    await ensureTmuxSession({ sessionName: sessionB, cwd });
    const server = http.createServer();
    attachTerminalWebSocket(server, (id) => (id === "a" ? sessionA : id === "b" ? sessionB : null));
    await listen(server);
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP test server address");
      const wsA = new WebSocket(`ws://127.0.0.1:${address.port}/terminal/a`);
      const wsB = new WebSocket(`ws://127.0.0.1:${address.port}/terminal/b`);
      await Promise.all([waitForOpen(wsA), waitForOpen(wsB)]);

      const outputA = waitForWebSocketOutput(wsA, "long-a-120");
      const outputB = waitForWebSocketOutput(wsB, "session-b-only");
      sendWsInput(wsA, "printf 'session-a-only\\n'; for i in $(seq 1 120); do echo long-a-$i; done");
      sendWsInput(wsA, "\r");
      sendWsInput(wsB, "printf session-b-only");
      sendWsInput(wsB, "\r");

      await Promise.all([outputA, outputB]);
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

  it("ensureTmuxSessionRaw runs the command without injecting the agent wrapper", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-bg-"));
    dirs.push(dir);
    const sessionName = `citadel_bg_test_${Date.now().toString(36)}`;
    sessions.push(sessionName);
    const sentinel = path.join(dir, "ran.txt");
    // The command writes a sentinel — proves the command ran. We then capture
    // the pane and assert it does NOT contain the wrapper's exit hint, which
    // would prove ensureTmuxSession's fallback-shell wrapper was injected.
    await ensureTmuxSessionRaw({
      sessionName,
      cwd: dir,
      command: "bash",
      args: ["-c", `echo started > ${shellQuote(sentinel)}; sleep 0.3`],
    });
    await waitFor(() => fs.existsSync(sentinel), 3000);
    expect(fs.readFileSync(sentinel, "utf8")).toContain("started");
    // Capture the pane regardless of whether it's still alive (remain-on-exit
    // tmux config may keep it). The wrapper string is what we don't want.
    const pane = captureTmux(sessionName, 200);
    expect(pane).not.toContain("[citadel] Agent exited");
  }, 10000);

  it("pipeBackgroundSessionToLog shellQuotes paths with spaces and streams pane output past the buffer threshold", async () => {
    // `head -c N` uses stdio buffering, so very small writes stay in the
    // 8KB-ish buffer until flush. Production agents emit MBs which is fine
    // (each ~8KB chunk flushes). The test pushes a >32KB block to verify the
    // pipe + path-with-spaces handling actually lands bytes on disk.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-pipe with space-"));
    dirs.push(dir);
    const sessionName = `citadel_bg_pipe_${Date.now().toString(36)}`;
    sessions.push(sessionName);
    const logPath = path.join(dir, "run.log");
    // 50,000 zeros via head from /dev/zero — over the buffer threshold.
    await ensureTmuxSessionRaw({
      sessionName,
      cwd: dir,
      command: "bash",
      args: ["-c", "sleep 0.3; head -c 50000 /dev/zero; sleep 0.5"],
    });
    pipeBackgroundSessionToLog(sessionName, logPath);
    await waitFor(() => fs.existsSync(logPath) && fs.statSync(logPath).size >= 1024, 5000);
    expect(fs.statSync(logPath).size).toBeGreaterThanOrEqual(1024);
    // stopBackgroundSessionPipe must not throw even if pane is dead.
    if (tmuxSessionExists(sessionName)) {
      expect(() => stopBackgroundSessionPipe(sessionName)).not.toThrow();
    }
  }, 15000);
});

async function waitFor(predicate: () => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("waitFor timed out");
}

async function waitForCapture(sessionName: string, expected: string, socketName?: string | null) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const output = captureTmux(sessionName, 200, socketName);
    if (output.includes(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${expected}`);
}

async function waitForVisibleScreen(sessionName: string, expected: string, socketName?: string | null) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const output = captureTmuxVisibleScreen(sessionName, 200, socketName);
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
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for HTTP test server close")), 10000);
    server.close((error) => {
      clearTimeout(timeout);
      error ? reject(error) : resolve();
    });
  });
}

function waitForOpen(ws: WebSocket) {
  return new Promise<void>((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for WebSocket open"));
    }, 10000);
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("WebSocket closed before open"));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      ws.off("open", onOpen);
      ws.off("error", onError);
      ws.off("close", onClose);
    };
    ws.once("open", onOpen);
    ws.once("error", onError);
    ws.once("close", onClose);
  });
}

function waitForClose(ws: WebSocket) {
  return new Promise<void>((resolve, reject) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for WebSocket close"));
    }, 10000);
    const onClose = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      clearTimeout(timeout);
      ws.off("close", onClose);
    };
    ws.once("close", onClose);
  });
}

function sendWsInput(ws: WebSocket, data: string) {
  ws.send(Buffer.from(data, "utf8"));
}

function waitForWebSocketOutput(ws: WebSocket, expected: string, type?: string) {
  return new Promise<void>((resolve, reject) => {
    let accumulated = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for WebSocket output ${expected}`));
    }, 5000);
    const onMessage = (raw: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) {
        if (!type || type === "binary") accumulated = `${accumulated}${raw.toString("utf8")}`.slice(-64_000);
      } else {
        const message = JSON.parse(raw.toString()) as { type?: string; data?: string };
        if ((!type || message.type === type) && message.data) {
          accumulated = `${accumulated}${message.data}`.slice(-64_000);
        }
      }
      if (accumulated.includes(expected)) {
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

function execTmux(args: string[]) {
  return execFileSync("tmux", args, { encoding: "utf8" });
}

function maybeExecTmux(args: string[]) {
  try {
    return execTmux(args);
  } catch {
    return null;
  }
}
