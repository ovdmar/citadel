import type { CitadelConfig } from "@citadel/config";
import type { CiProviderSummary, VersionControlSummary } from "@citadel/contracts";
import type { SqliteStore } from "@citadel/db";

// Reuse the decide function from the daemon. Importing it here would create
// a circular dep (operations → daemon); instead, the daemon's tick driver
// passes the decide function in via deps. This keeps operations free of
// daemon-specific imports.

export type AutoRecoveryDecision = {
  fire: boolean;
  reason: string;
  sha: string | null;
};

export type AutoRecoveryDecisionInput = {
  workspace: {
    id: string;
    autoRecoveryLastCiSha: string | null;
    autoRecoveryLastAttemptAt: string | null;
  };
  sessions: Array<{ status: string; runtimeId: string | null; lastActivityAt: string | null }>;
  pr: {
    headSha: string | null;
    mergeable: string | null;
    checks: Array<{ status: string; conclusion: string | null }>;
  } | null;
  runtimeId: string | null;
  now: Date;
  idleThresholdMs: number;
  debounceMs: number;
  disabled: boolean;
};

export type AutoRecoveryMonitorDeps = {
  store: SqliteStore;
  config: CitadelConfig;
  decide: (input: AutoRecoveryDecisionInput) => AutoRecoveryDecision;
  // Fetch latest provider data for a workspace. The daemon wires its
  // cachedProvider here so we don't blow up the gh rate-limit.
  fetchVersionControl: (workspacePath: string) => Promise<VersionControlSummary>;
  fetchCi: (workspacePath: string) => Promise<CiProviderSummary>;
  // Spawn the auto-recovery agent. Takes the resolved prompt + activitySource.
  spawnAutoRecoveryAgent: (input: {
    workspaceId: string;
    runtimeId: string;
    prompt: string;
  }) => Promise<{ id: string }>;
  prompt: string;
  // Configurable knobs surfaced as env-driven defaults by the daemon caller.
  idleThresholdMs: number;
  debounceMs: number;
  disabled: boolean;
  readKnobs?: () => { idleThresholdMs: number; debounceMs: number; disabled: boolean };
  // Optional runtime resolver. The daemon uses this to health-gate the
  // configured primary/fallback runtime before this pure monitor attempts a
  // spawn. Omitted keeps the older first-non-shell behavior for tests and
  // non-daemon callers.
  resolveRuntimeId?: () => string | null;
  // Optional gate consulted at the top of each tick. When provided and it
  // returns false, the entire tick short-circuits — no provider calls, no
  // decide invocations, no agent spawn. Used by the daemon's viewer-gate to
  // stop consuming GitHub quota when no cockpit tab is connected.
  // Backwards compatible: omitted ⇒ tick always runs (prior behavior).
  shouldRun?: () => boolean;
  // Optional emitter for tests / observability.
  onEvent?: (event: { workspaceId: string; reason: string; fired: boolean }) => void;
};

export type AutoRecoveryMonitorHandle = { stop: () => void };

function mostRecent(...values: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  for (const value of values) {
    if (!value) continue;
    if (!best || value > best) best = value;
  }
  return best;
}

// Resolve the auto-recovery runtime for a workspace: pick a configured agent runtime.
function pickRuntime(config: CitadelConfig): string | null {
  const configured = config.automations?.fixCi;
  const runtimeIds = new Set(config.agentRuntimes.map((candidate) => candidate.id));
  for (const id of [configured?.runtimeId, configured?.fallbackRuntimeId ?? undefined]) {
    if (id && runtimeIds.has(id)) return id;
  }
  const runtime = config.agentRuntimes[0];
  return runtime?.id ?? null;
}

// One tick: iterate workspaces, fetch provider data, decide, and (if firing
// AND the atomic UPDATE claims the slot) spawn the agent. Exported as its
// own function so tests can drive it directly without setInterval.
export async function runAutoRecoveryTick(deps: AutoRecoveryMonitorDeps, now: Date = new Date()): Promise<void> {
  const knobs = deps.readKnobs?.() ?? {
    idleThresholdMs: deps.idleThresholdMs,
    debounceMs: deps.debounceMs,
    disabled: deps.disabled,
  };
  if (knobs.disabled) return;
  if (deps.shouldRun && !deps.shouldRun()) return;
  const runtimeId = deps.resolveRuntimeId ? deps.resolveRuntimeId() : pickRuntime(deps.config);
  if (!runtimeId) return;

  const workspaces = deps.store.listWorkspaces();
  for (const workspace of workspaces) {
    if (workspace.lifecycle !== "ready") continue;
    let vc: VersionControlSummary;
    try {
      vc = await deps.fetchVersionControl(workspace.path);
    } catch {
      // Provider unavailable — skip this workspace this tick. The next tick
      // will pick it up if the provider recovers.
      continue;
    }
    if (vc.status !== "healthy" || !vc.pullRequest) {
      // Provider-degradation policy: never auto-spawn on stale data.
      continue;
    }
    let ci: CiProviderSummary;
    try {
      ci = await deps.fetchCi(workspace.path);
    } catch {
      continue;
    }
    if (ci.status !== "healthy") {
      continue;
    }
    const state = deps.store.getWorkspaceAutoRecoveryState(workspace.id);
    const sessions = deps.store.listSessions(workspace.id);
    const decision = deps.decide({
      workspace: {
        id: workspace.id,
        autoRecoveryLastCiSha: state?.lastCiSha ?? null,
        autoRecoveryLastAttemptAt: state?.lastAttemptAt ?? null,
      },
      sessions: sessions.map((session) => ({
        status: session.status,
        runtimeId: session.runtimeId,
        // updatedAt is bumped on every status-reducer write (including the
        // final stopped/failed transition), so including it would inflate the
        // idle window after a session ends. Use only timestamps that track
        // genuine activity.
        lastActivityAt: mostRecent(session.lastOutputAt, session.lastStatusAt),
      })),
      pr: {
        headSha: vc.pullRequest.headSha ?? null,
        mergeable: vc.pullRequest.mergeable ?? null,
        checks: vc.pullRequest.checks ?? [],
      },
      runtimeId,
      now,
      idleThresholdMs: knobs.idleThresholdMs,
      debounceMs: knobs.debounceMs,
      disabled: knobs.disabled,
    });
    deps.onEvent?.({ workspaceId: workspace.id, reason: decision.reason, fired: decision.fire });
    if (!decision.fire || !decision.sha) continue;

    const debounceCutoff = new Date(now.getTime() - knobs.debounceMs).toISOString();
    const claimed = deps.store.tryRecordAutoRecoveryAttempt({
      workspaceId: workspace.id,
      sha: decision.sha,
      now: now.toISOString(),
      debounceCutoff,
    });
    if (!claimed) continue; // a concurrent tick won the race; skip the spawn.

    try {
      await deps.spawnAutoRecoveryAgent({
        workspaceId: workspace.id,
        runtimeId,
        prompt: deps.prompt,
      });
    } catch {
      // The agent spawn failed; the SHA is still persisted so we don't
      // retry-storm. Operators see the error in the activity log.
    }
  }
}

export function startAutoRecoveryMonitor(
  deps: AutoRecoveryMonitorDeps,
  intervalMs: number | (() => number) = 60_000,
): AutoRecoveryMonitorHandle {
  let running = false;
  let stopped = false;
  let handle: ReturnType<typeof setTimeout> | null = null;
  const readInterval = () => Math.max(1000, typeof intervalMs === "function" ? intervalMs() : intervalMs);
  const schedule = () => {
    if (stopped) return;
    handle = setTimeout(tick, readInterval());
    if (typeof (handle as { unref?: () => void }).unref === "function") {
      (handle as { unref: () => void }).unref();
    }
  };
  const tick = () => {
    if (stopped) return;
    if (running) return;
    running = true;
    runAutoRecoveryTick(deps)
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[auto-recovery] tick failed:", err);
      })
      .finally(() => {
        running = false;
        schedule();
      });
  };
  schedule();
  return {
    stop: () => {
      stopped = true;
      if (handle) clearTimeout(handle);
    },
  };
}
