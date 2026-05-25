import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type EphemeralTmux = {
  session: string;
  capture(): string;
  sendText(text: string): void;
  sendKey(key: string): void;
  waitFor(predicate: (text: string) => boolean, opts?: { timeoutMs?: number; intervalMs?: number }): Promise<string>;
  kill(): void;
};

// Spawn a one-shot tmux session running `command args` in a large virtual
// terminal. Caller is responsible for calling `kill()` (use try/finally).
//
// Designed for short-lived "probe" interactions like driving `/usage` or
// `/status` panels. We deliberately do NOT use packages/terminal's
// ensureTmuxSession here — the wrapper script (sentinels, fallback shell,
// pipe-pane log) is overhead the probe doesn't need and would interfere with
// the parser by adding the wrapper banner at the top of the captured pane.
export async function spawnEphemeralTmux(input: {
  command: string;
  args?: string[];
  width?: number;
  height?: number;
  scrollback?: number;
  sessionPrefix?: string;
}): Promise<EphemeralTmux> {
  const width = input.width ?? 200;
  const height = input.height ?? 60;
  const scrollback = input.scrollback ?? 500;
  const sessionPrefix = input.sessionPrefix ?? "citadel_usage";
  const session = `${sessionPrefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const argv = [input.command, ...(input.args ?? [])].map(shellQuote).join(" ");
  // 2>&1 keeps stderr in the pane so paint errors still show up in captures.
  await execFileAsync(
    "tmux",
    ["new-session", "-d", "-s", session, "-x", String(width), "-y", String(height), `${argv} 2>&1`],
    { timeout: 10_000 },
  );

  const capture = (): string => {
    try {
      return execFileSync("tmux", ["capture-pane", "-p", "-J", "-S", `-${scrollback}`, "-t", session], {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return "";
    }
  };

  return {
    session,
    capture,
    sendText(text: string) {
      // -l means literal; no escape-sequence interpretation. Use this for slash
      // commands and free-form text.
      execFileSync("tmux", ["send-keys", "-l", "-t", session, text], { stdio: "ignore" });
    },
    sendKey(key: string) {
      execFileSync("tmux", ["send-keys", "-t", session, key], { stdio: "ignore" });
    },
    async waitFor(predicate, opts = {}) {
      const timeoutMs = opts.timeoutMs ?? 25_000;
      const intervalMs = opts.intervalMs ?? 400;
      const deadline = Date.now() + timeoutMs;
      let last = "";
      while (Date.now() < deadline) {
        last = capture();
        if (predicate(last)) return last;
        await sleep(intervalMs);
      }
      return last;
    },
    kill() {
      try {
        execFileSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" });
      } catch {
        /* best-effort */
      }
    },
  };
}

export function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export function stripAnsi(input: string) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping real ANSI escapes
  return input.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

function shellQuote(value: string) {
  if (/^[A-Za-z0-9_/:=.,+@%-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
