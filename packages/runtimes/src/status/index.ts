// Per-runtime status detection — pane-based, fixture-driven.
//
// Each adapter inspects the pane capture on every monitor tick and returns one
// of: "running" | "idle" | "waiting_for_input" | "rate_limited" | "usage_limited" | null. The
// reducer (@citadel/operations) applies the observation with stickiness rules.
//
// Lifecycle signals (tmux_missing, exited_clean/failed) come from the monitor's
// own deterministic checks (tmux session existence, bash wrapper sentinel
// files) and are runtime-agnostic — adapters do NOT produce those.
//
// Failure modes are honest: adapters never fabricate completions. The worst
// case for a UI change in a runtime is "no completion sound fires" (the
// regex stops matching), caught by fixture-driven tests.

import { claudeCodeStatusAdapter } from "./claude-code.js";
import { codexStatusAdapter } from "./codex.js";
import type { ActiveElapsedTimerProbe } from "./elapsed-timer.js";

export type PaneObservation = "running" | "idle" | "waiting_for_input" | "rate_limited" | "usage_limited";

// What an adapter returns. Shorthand: just the observation (reason will be
// auto-derived). Full form: observation plus a custom reason string that the
// reducer threads onto statusReason (used by usage_limited to carry the
// parsed reset timestamp so auto-resume can read it without re-parsing the
// pane).
export type PaneObservationResult = PaneObservation | { observed: PaneObservation; reason: string };

export interface ObservationContext {
  // Most recent visible-pane capture (no scrollback). Adapter regexes are
  // anchored to the bottom-most non-empty line via the lastNonEmptyLine helper.
  paneCapture: string;
  // Whether tmux #{session_activity} changed since the last tick.
  tmuxActivityChangedSinceLastTick: boolean;
  // Number of consecutive prior ticks where activity DIDN'T change.
  // Used by codex-fallback for the ≥2-stable-ticks idle rule.
  ticksSinceActivityChange: number;
  // Source of this tick. The monitor passes "boot" on the daemon's
  // first-pass reconcile, "tick" thereafter. Adapters use this to
  // suppress idle on first post-boot tick when state is empty.
  source: "boot" | "tick";
  // Whether the monitor has observed at least one prior tick since boot
  // for this session. Used by codex idle suppression on cold start.
  hasObservedSinceBoot: boolean;
  // Wall-clock now. Injected so adapters that parse relative times (e.g.
  // claude-code's `resets HH:MMam (UTC)` usage-limit banner) stay
  // deterministic under test. Wiring supplies `new Date()` per tick.
  now?: () => Date;
  // Runtime-agnostic first-pass probe. The status monitor may precompute it
  // before lifecycle checks so an advancing visible timer can beat weaker
  // foreground-process heuristics.
  activeElapsedTimer?: ActiveElapsedTimerProbe;
}

export interface SessionAdapterState {
  // Runtime-specific. The base interface has just these.
  ticksObserved: number;
  lastPaneHash: string | null;
}

export interface RuntimeStatusAdapter {
  runtimeId: string;
  createSessionState(): SessionAdapterState;
  // Inspect the pane (and tmux activity, via ctx) and decide status.
  // Returns null when the adapter has no opinion this tick.
  observe(state: SessionAdapterState, ctx: ObservationContext): PaneObservationResult | null;
}

const NOOP_ADAPTER: RuntimeStatusAdapter = {
  runtimeId: "noop",
  createSessionState: () => ({ ticksObserved: 0, lastPaneHash: null }),
  observe: () => null,
};

// Adapter registry. Cursor-agent and any unknown runtime fall back to the
// codex adapter — same heuristics (pane-activity timestamp + sandbox-style
// chrome footer). The noop adapter is a defensive default.
export function getStatusAdapter(runtimeId: string): RuntimeStatusAdapter {
  switch (runtimeId) {
    case "claude-code":
      return claudeCodeStatusAdapter;
    case "codex":
    case "cursor-agent":
      return codexStatusAdapter;
    default:
      return NOOP_ADAPTER;
  }
}

export { claudeCodeStatusAdapter } from "./claude-code.js";
export {
  CODEX_REASON_CURRENT_TURN_DIVIDER,
  CODEX_REASON_INTERRUPT,
  CODEX_REASON_SANDBOX_APPROVAL,
  CODEX_REASON_STABLE_TIMEOUT,
  codexStatusAdapter,
} from "./codex.js";
export { REASON_ELAPSED_TIMER, observeActiveElapsedTimer } from "./elapsed-timer.js";
export type { ActiveElapsedTimerProbe } from "./elapsed-timer.js";

// Utility shared by adapters: bottom-most non-empty line of the visible pane,
// trimmed of surrounding whitespace. All chrome regexes are anchored to this
// single line to avoid false matches in agent output body.
export function lastNonEmptyLine(paneCapture: string): string {
  const lines = paneCapture.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line !== undefined && line.trim().length > 0) return line.trim();
  }
  return "";
}
