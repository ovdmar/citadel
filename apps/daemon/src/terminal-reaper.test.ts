import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startTerminalReaper } from "./terminal-reaper.js";

const REAP_MS = 5 * 60 * 1000;
const ROTATE_MS = 6 * 60 * 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function makeHarness(listOutput: string) {
  const detached: string[] = [];
  const listClients = vi.fn(() => listOutput);
  const detachClient = vi.fn((tty: string) => {
    detached.push(tty);
  });
  const sweepPtyLogs = vi.fn(() => ({ scanned: 0, removed: 0 }));
  return { detached, listClients, detachClient, sweepPtyLogs };
}

describe("startTerminalReaper", () => {
  it("detaches clients whose owning process is gone (ESRCH)", () => {
    const deadPid = pickDeadPid();
    const harness = makeHarness(`/dev/pts/99 ${deadPid}\n`);

    const handle = startTerminalReaper({ reapIntervalMs: REAP_MS, rotateIntervalMs: ROTATE_MS, ...harness });
    vi.advanceTimersByTime(REAP_MS);

    expect(harness.detached).toEqual(["/dev/pts/99"]);
    handle.stop();
  });

  it("does NOT detach clients whose owning process is alive", () => {
    const harness = makeHarness(`/dev/pts/42 ${process.pid}\n`);

    const handle = startTerminalReaper({ reapIntervalMs: REAP_MS, rotateIntervalMs: ROTATE_MS, ...harness });
    vi.advanceTimersByTime(REAP_MS);

    expect(harness.detached).toEqual([]);
    handle.stop();
  });

  it("ignores lines with empty or zero pid", () => {
    const harness = makeHarness("/dev/pts/1 \n/dev/pts/2 0\n/dev/pts/3 not-a-number\n");

    const handle = startTerminalReaper({ reapIntervalMs: REAP_MS, rotateIntervalMs: ROTATE_MS, ...harness });
    vi.advanceTimersByTime(REAP_MS);

    expect(harness.detached).toEqual([]);
    handle.stop();
  });

  it("swallows listClients failures", () => {
    const harness = makeHarness("");
    harness.listClients.mockImplementation(() => {
      throw new Error("no server running");
    });

    const handle = startTerminalReaper({ reapIntervalMs: REAP_MS, rotateIntervalMs: ROTATE_MS, ...harness });
    expect(() => vi.advanceTimersByTime(REAP_MS)).not.toThrow();
    handle.stop();
  });

  it("swallows detachClient failures", () => {
    const deadPid = pickDeadPid();
    const harness = makeHarness(`/dev/pts/55 ${deadPid}\n/dev/pts/56 ${deadPid}\n`);
    harness.detachClient.mockImplementationOnce(() => {
      throw new Error("client already gone");
    });

    const handle = startTerminalReaper({ reapIntervalMs: REAP_MS, rotateIntervalMs: ROTATE_MS, ...harness });
    expect(() => vi.advanceTimersByTime(REAP_MS)).not.toThrow();
    // second call still attempted despite first one throwing
    expect(harness.detachClient).toHaveBeenCalledTimes(2);
    handle.stop();
  });

  it("calls sweepPtyLogs on the rotate interval", () => {
    const harness = makeHarness("");

    const handle = startTerminalReaper({
      reapIntervalMs: REAP_MS,
      rotateIntervalMs: ROTATE_MS,
      ptyLogMaxAgeMs: 1234,
      ...harness,
    });

    vi.advanceTimersByTime(ROTATE_MS);

    expect(harness.sweepPtyLogs).toHaveBeenCalledWith(1234);
    handle.stop();
  });

  it("returns a no-op handle when CITADEL_DISABLE_TERMINAL_REAPER=1", () => {
    vi.stubEnv("CITADEL_DISABLE_TERMINAL_REAPER", "1");
    const deadPid = pickDeadPid();
    const harness = makeHarness(`/dev/pts/77 ${deadPid}\n`);
    const handle = startTerminalReaper({ reapIntervalMs: REAP_MS, rotateIntervalMs: ROTATE_MS, ...harness });

    vi.advanceTimersByTime(REAP_MS * 5);
    vi.advanceTimersByTime(ROTATE_MS * 2);

    expect(harness.listClients).not.toHaveBeenCalled();
    expect(harness.detached).toEqual([]);
    expect(harness.sweepPtyLogs).not.toHaveBeenCalled();
    expect(() => handle.stop()).not.toThrow();
    vi.unstubAllEnvs();
  });

  it("stop() prevents subsequent ticks", () => {
    const deadPid = pickDeadPid();
    const harness = makeHarness(`/dev/pts/77 ${deadPid}\n`);

    const handle = startTerminalReaper({ reapIntervalMs: REAP_MS, rotateIntervalMs: ROTATE_MS, ...harness });
    handle.stop();
    vi.advanceTimersByTime(REAP_MS * 10);

    expect(harness.detached).toEqual([]);
  });
});

// Use a large PID that is extremely unlikely to be in use, so process.kill(pid, 0)
// reliably throws ESRCH. Linux max pid is typically 2^22 = 4194304; we pick higher.
function pickDeadPid(): number {
  return 4_000_000_000;
}
