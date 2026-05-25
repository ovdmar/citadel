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

// Resolve the auto-recovery runtime for a workspace: pick the first
// non-shell runtime configured. Operators that configure only a shell
// runtime opt out of auto-recovery — there's no agent to ping.
function pickRuntime(config: CitadelConfig): string | null {
  const runtime = config.runtimes.find((candidate) => candidate.id !== "shell");
  return runtime?.id ?? null;
}

// One tick: iterate workspaces, fetch provider data, decide, and (if firing
// AND the atomic UPDATE claims the slot) spawn the agent. Exported as its
// own function so tests can drive it directly without setInterval.
export async function runAutoRecoveryTick(deps: AutoRecoveryMonitorDeps, now: Date = new Date()): Promise<void> {
  if (deps.disabled) return;
  const runtimeId = pickRuntime(deps.config);
  if (!runtimeId) return;

  const workspaces = deps.store.listWorkspaces();
  for (const workspace of workspaces) {
    if (workspace.lifecycle !== "ready") continue;
    let vc: VersionControlSummary;
    let ci: CiProviderSummary;
    try {
      [vc, ci] = await Promise.all([deps.fetchVersionControl(workspace.path), deps.fetchCi(workspace.path)]);
    } catch {
      // Provider unavailable — skip this workspace this tick. The next tick
      // will pick it up if the provider recovers.
      continue;
    }
    if (vc.status !== "healthy" || ci.status !== "healthy") {
      // Provider-degradation policy: never auto-spawn on stale data.
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
        lastActivityAt: mostRecent(session.lastOutputAt, session.lastStatusAt, session.updatedAt),
      })),
      pr: vc.pullRequest
        ? {
            headSha: extractHeadSha(ci),
            mergeable: vc.pullRequest.mergeable ?? null,
            checks: vc.pullRequest.checks ?? [],
          }
        : null,
      runtimeId,
      now,
      idleThresholdMs: deps.idleThresholdMs,
      debounceMs: deps.debounceMs,
      disabled: deps.disabled,
    });
    deps.onEvent?.({ workspaceId: workspace.id, reason: decision.reason, fired: decision.fire });
    if (!decision.fire || !decision.sha) continue;

    const debounceCutoff = new Date(now.getTime() - deps.debounceMs).toISOString();
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

// Extract the head SHA from the CI provider summary. gh runs include
// headSha but it's not in the normalized CiRunSummary contract — fall back
// to null when missing (the decide function skips on null).
function extractHeadSha(ci: CiProviderSummary): string | null {
  const run = ci.runs[0];
  if (!run) return null;
  // The raw gh output has headSha; our CiRunSummary doesn't carry it
  // explicitly today. Cast through a loose shape — when not present, return
  // null and let the decide function skip.
  const loose = run as Record<string, unknown>;
  const headSha = loose.headSha;
  return typeof headSha === "string" ? headSha : null;
}

export function startAutoRecoveryMonitor(
  deps: AutoRecoveryMonitorDeps,
  intervalMs = 60_000,
): AutoRecoveryMonitorHandle {
  let running = false;
  const handle = setInterval(() => {
    if (running) return;
    running = true;
    runAutoRecoveryTick(deps)
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[auto-recovery] tick failed:", err);
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  if (typeof (handle as { unref?: () => void }).unref === "function") {
    (handle as { unref: () => void }).unref();
  }
  return { stop: () => clearInterval(handle) };
}
