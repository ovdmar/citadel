import { type ResolvedTheme, readResolvedTheme, subscribeResolvedTheme } from "./use-resolved-theme.js";

/**
 * Orchestrates live re-theming of running terminals when the cockpit theme
 * changes. The orchestrator subscribes to `subscribeResolvedTheme` (the same
 * channel `useResolvedTheme` uses) so it fires for both user-driven theme
 * cycles AND OS-driven `prefers-color-scheme` flips when the user is on
 * "system".
 *
 * For each new resolved theme:
 *   1. List currently registered terminal handles (random order, see below).
 *   2. Skip handles whose `lastKnownTheme` already matches the new theme
 *      (idempotency — avoids cleanup-storm on no-op transitions).
 *   3. Call `handle.reload(theme)` — which under the hood passes
 *      `{ force: true, bumpFrame: true, theme }` to the daemon's ensure().
 *   4. Stagger respawns with a small delay so all open terminals don't
 *      simultaneously hit the daemon's spawn path (regression class
 *      documented in MEMORY/project_ttyd_cleanup_storms).
 *   5. Bail out of the loop if a NEWER theme change has superseded this one
 *      (sequence-token cancellation) — rapid toggles coalesce to the latest.
 *
 * Handle iteration order is shuffled per loop so that, under sustained rapid
 * toggling, tail handles aren't perpetually starved by the sequence-token
 * cancellation hitting at the same iteration boundary every time.
 */

/** Public shape the orchestrator needs from a registered terminal handle. */
export type ReThemeableHandle = {
  /** Most recent theme this handle was rendered with — null if unknown / never set. */
  lastKnownTheme: ResolvedTheme | null;
  /** Trigger a respawn with an explicit theme. */
  reload: (theme: ResolvedTheme) => void;
};

/** Function that returns the currently registered handles. */
export type HandleSource = () => Array<[string, ReThemeableHandle]>;

/** Wait for `ms` milliseconds, awaitable with fake timers. */
export type Delay = (ms: number) => Promise<void>;

const DEFAULT_STAGGER_MS = 80;

export type OrchestratorOptions = {
  /** Returns the registered handles to iterate. */
  getHandles: HandleSource;
  /** Subscribe-on-theme-change. Returns a cleanup. Defaults to subscribeResolvedTheme. */
  subscribe?: (callback: (theme: ResolvedTheme) => void) => () => void;
  /** Compute the current resolved theme synchronously. Defaults to readResolvedTheme. */
  readNow?: () => ResolvedTheme;
  /** Sleep between handle respawns. Defaults to setTimeout. */
  delay?: Delay;
  /** Stagger duration in ms. Defaults to 80ms. */
  staggerMs?: number;
  /** Logger for per-handle reload errors. Defaults to console.warn. */
  onError?: (handleKey: string, error: unknown) => void;
  /** Shuffle function — exposed so tests can pin iteration order deterministically. */
  shuffle?: <T>(items: T[]) => T[];
};

export type OrchestratorHandle = {
  /** Stop subscribing and abort any in-flight loop. */
  cleanup: () => void;
};

/**
 * Setup the orchestrator. Returns a cleanup function via the handle so the
 * caller can tear down on HMR (the cockpit's main.tsx stores the cleanup
 * in a module-level variable and invokes it before remounting).
 */
export function setupReThemeOrchestrator(options: OrchestratorOptions): OrchestratorHandle {
  const subscribe = options.subscribe ?? subscribeResolvedTheme;
  const readNow = options.readNow ?? readResolvedTheme;
  const delay = options.delay ?? defaultDelay;
  const staggerMs = options.staggerMs ?? DEFAULT_STAGGER_MS;
  const onError = options.onError ?? defaultOnError;
  const shuffle = options.shuffle ?? defaultShuffle;

  let currentSeq = 0;
  let teardown: (() => void) | null = null;

  const runFor = async (theme: ResolvedTheme): Promise<void> => {
    const mySeq = ++currentSeq;
    const handles = shuffle(options.getHandles());
    for (let i = 0; i < handles.length; i += 1) {
      // A newer toggle landed mid-loop — bail so we don't keep respawning
      // terminals with a theme the user no longer wants.
      if (mySeq !== currentSeq) return;
      const entry = handles[i];
      if (!entry) continue;
      const [key, handle] = entry;
      if (handle.lastKnownTheme === theme) continue;
      try {
        handle.reload(theme);
      } catch (error) {
        onError(key, error);
      }
      // Don't sleep after the last handle — finishes the loop sooner under
      // tests with fake timers and trims one stagger window in production.
      if (i < handles.length - 1) {
        await delay(staggerMs);
      }
    }
  };

  // Seed `lastEmitted` inside the subscribe channel by reading once. We do
  // not kick off a run for the initial value — the assumption is that any
  // already-mounted terminal was spawned with the right theme by its own
  // first ensure() call. We only respawn on CHANGES.
  void readNow();

  teardown = subscribe((next) => {
    void runFor(next);
  });

  return {
    cleanup: () => {
      // Invalidate any in-flight loop and disconnect from the channel.
      currentSeq += 1;
      teardown?.();
      teardown = null;
    },
  };
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultOnError(handleKey: string, error: unknown): void {
  console.warn(`[re-theme] handle ${handleKey} reload failed:`, error);
}

// Fisher-Yates in-place shuffle, returning the (mutated) array.
function defaultShuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = items[i];
    const b = items[j];
    if (a === undefined || b === undefined) continue;
    items[i] = b;
    items[j] = a;
  }
  return items;
}

// Exposed for tests.
export { defaultShuffle };
