// Tiny shared helper for daemon loops that need:
//   1. setInterval + clearInterval
//   2. .unref() so the timer doesn't block process exit
//   3. an "in-flight" guard so a slow tick doesn't get a second one stacked
//      on top of it (which would double work and burn rate-limit windows)
//   4. caller-supplied error logging so a single bad tick doesn't crash
//
// Used by startStatusMonitor (2s tmux poll) and startAutoResumeLoop (60s
// rate-limit nudge). Extracting the pattern means a regression in the
// overlap guard fails one test, not "everything is fine".

export interface GuardedIntervalHandle {
  stop: () => void;
}

export interface GuardedIntervalLogger {
  error(message: string, err: unknown): void;
}

export function startGuardedInterval(
  tick: () => unknown,
  intervalMs: number,
  logger?: GuardedIntervalLogger,
): GuardedIntervalHandle {
  let running = false;
  const handle = setInterval(() => {
    if (running) return; // previous tick still in flight — skip this one
    running = true;
    Promise.resolve()
      .then(() => tick())
      .catch((err) => {
        if (logger) logger.error("[guarded-interval] tick failed", err);
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  if (typeof (handle as { unref?: () => void }).unref === "function") {
    (handle as { unref: () => void }).unref();
  }
  return {
    stop: () => clearInterval(handle),
  };
}
