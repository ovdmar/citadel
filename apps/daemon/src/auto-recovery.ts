import { CITADEL_NON_FF_POLICY } from "@citadel/hooks";

// Hardcoded prompt for the auto-launched fix-CI agent. No hook override for
// now — that's a follow-up if operators ask. Referenced by the auto-recovery
// monitor + by the decide function's tests.
export const FIX_CI_PROMPT = [
  "The PR for this workspace has failing CI checks and no agent has been working",
  "on this workspace recently. You were auto-launched by Citadel to investigate.",
  "",
  "Investigate and fix:",
  "1. Run `gh pr checks` to identify failing jobs.",
  "2. For each failing job, run `gh run view <id> --log-failed` (or `--log`) to",
  "   read the actual error.",
  "3. Reproduce locally with the same command CI runs.",
  "4. Fix the underlying cause. Do NOT delete or skip tests, types, or assertions",
  "   to make CI pass — fix the root cause.",
  "5. Run `make check` (or the minimal targeted subset).",
  `6. Commit with a focused message and \`git push\`. ${CITADEL_NON_FF_POLICY}`,
  "",
  "If you genuinely cannot fix the failure, stop and explain why in the activity",
  "log. Do NOT loop indefinitely.",
].join("\n");

export type AutoRecoveryDecisionInput = {
  workspace: {
    id: string;
    autoRecoveryLastCiSha: string | null;
    autoRecoveryLastAttemptAt: string | null;
  };
  // The latest meaningful activity timestamp across this workspace's
  // sessions (max of lastOutputAt/lastStatusAt — caller computes). NOTE:
  // session.updatedAt is intentionally excluded because the status reducer
  // bumps it on the final stopped/failed transition too, which would
  // artificially extend the idle window after a session ends.
  sessions: Array<{ status: string; runtimeId: string | null; lastActivityAt: string | null }>;
  pr: {
    headSha: string | null;
    mergeable: string | null;
    checks: Array<{ status: string; conclusion: string | null }>;
  } | null;
  // Whether the workspace has a non-shell runtime configured to receive the
  // auto-launch. When null we skip (no runtime to launch into).
  runtimeId: string | null;
  now: Date;
  idleThresholdMs: number;
  debounceMs: number;
  disabled: boolean;
};

export type AutoRecoveryDecision = {
  fire: boolean;
  reason: string;
  // SHA to persist as auto_recovery_last_ci_sha when firing.
  sha: string | null;
};

// Pure: decide whether a workspace's CI-red + idle state warrants an
// auto-launched fix-CI agent. The caller does the persistence + spawn.
//
// Fires iff:
//   - not disabled,
//   - a runtime is configured,
//   - a PR with a known head SHA exists,
//   - at least one check is failing (failure/cancelled/timed_out/action_required),
//   - no session is currently starting/running,
//   - the most recent session activity is older than idleThresholdMs,
//   - (headSha != lastCiSha) OR (now - lastAttemptAt > debounceMs).
//
// The debounce arm covers same-SHA CI re-runs and the two-daemon-tick race —
// the monitor pairs this decision with an atomic UPDATE that filters on both
// columns, so a concurrent tick that already fired sees 0 rows affected.
export function decideAutoRecoveryAction(input: AutoRecoveryDecisionInput): AutoRecoveryDecision {
  if (input.disabled) return { fire: false, reason: "auto_recovery_disabled", sha: null };
  if (!input.runtimeId) return { fire: false, reason: "no_runtime_configured", sha: null };
  if (!input.pr || !input.pr.headSha) return { fire: false, reason: "no_pr_or_head_sha", sha: null };

  const failingCheck = input.pr.checks.some((check) =>
    ["failure", "cancelled", "timed_out", "action_required"].includes(String(check.conclusion ?? "").toLowerCase()),
  );
  if (!failingCheck) return { fire: false, reason: "ci_not_failing", sha: input.pr.headSha };

  const activeSession = input.sessions.some(
    (session) => session.runtimeId !== "shell" && ["starting", "running"].includes(session.status),
  );
  if (activeSession) return { fire: false, reason: "agent_session_active", sha: input.pr.headSha };

  const latestActivity = mostRecent(input.sessions.map((session) => session.lastActivityAt));
  if (latestActivity) {
    const idleFor = input.now.getTime() - Date.parse(latestActivity);
    if (Number.isFinite(idleFor) && idleFor < input.idleThresholdMs) {
      return { fire: false, reason: "within_idle_window", sha: input.pr.headSha };
    }
  }

  const headSha = input.pr.headSha;
  const shaMatchesLast = input.workspace.autoRecoveryLastCiSha === headSha;
  const debouncedRecently =
    input.workspace.autoRecoveryLastAttemptAt &&
    input.now.getTime() - Date.parse(input.workspace.autoRecoveryLastAttemptAt) < input.debounceMs;
  if (shaMatchesLast && debouncedRecently) {
    return { fire: false, reason: "sha_dedupe_and_debounced", sha: headSha };
  }

  return { fire: true, reason: shaMatchesLast ? "ci_red_debounce_expired" : "ci_red_new_sha", sha: headSha };
}

function mostRecent(values: Array<string | null>): string | null {
  let best: string | null = null;
  for (const value of values) {
    if (!value) continue;
    if (!best || value > best) best = value;
  }
  return best;
}
