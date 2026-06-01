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
  ensureTmuxExtendedKeys,
  ensureTmuxSession,
  ensureTmuxSessionRaw,
  isAgentLive,
  killTmuxSession,
  parseTmuxControlOutput,
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
const dirs: string[] = [];

afterEach(() => {
  for (const session of sessions.splice(0)) killTmuxSession(session);
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("tmux terminal gateway helpers", () => {
  it("recognizes collapsed paste markers from Claude Code and Codex", () => {
    expect(hasCollapsedPasteMarker("[Pasted text #1 +101 lines]")).toBe(true);
    expect(hasCollapsedPasteMarker("[Pasted Content 3298 chars]")).toBe(true);
    expect(hasCollapsedPasteMarker("Pasted Content 3298 chars")).toBe(false);
  });

  it("decodes tmux control-mode output chunks", () => {
    expect(parseTmuxControlOutput("%output %1 hello\\015\\012")).toBe("hello\r\n");
    expect(parseTmuxControlOutput("%session-changed $1 shell")).toBeNull();
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
    const terminalFeatures = execTmux(["show-options", "-s", "-g", "terminal-features"]);
    const historyLimit = execTmux(["show-options", "-g", "history-limit"]);
    expect(extendedKeys).toContain("extended-keys on");
    expect(terminalFeatures).toMatch(/xterm\*.*extkeys/);
    expect(historyLimit).toContain("history-limit 5000");
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
    });
    const server = http.createServer();
    attachTerminalWebSocket(server, (id) => (id === "sess_test" ? sessionName : null));
    await listen(server);
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP test server address");
      const ws = new WebSocket(`ws://127.0.0.1:${address.port}/terminal/sess_test`);
      await waitForOpen(ws);

      const streamedOutput = waitForWebSocketOutput(ws, "websocket-smoke", "outputChunk");
      ws.send(JSON.stringify({ type: "input", data: "printf websocket-smoke" }));
      ws.send(JSON.stringify({ type: "input", data: "\r" }));
      await waitForWebSocketOutput(ws, "websocket-smoke");
      await streamedOutput;

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

async function waitForCapture(sessionName: string, expected: string) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const output = captureTmux(sessionName, 200);
    if (output.includes(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${expected}`);
}

async function waitForVisibleScreen(sessionName: string, expected: string) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const output = captureTmuxVisibleScreen(sessionName, 200);
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

function waitForWebSocketOutput(ws: WebSocket, expected: string, type?: string) {
  return new Promise<void>((resolve, reject) => {
    let accumulated = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for WebSocket output ${expected}`));
    }, 5000);
    const onMessage = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString()) as { type?: string; data?: string };
      if ((!type || message.type === type) && message.data) {
        accumulated = `${accumulated}${message.data}`.slice(-64_000);
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
