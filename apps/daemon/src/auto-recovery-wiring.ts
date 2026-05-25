// Wires the CI auto-recovery tick into the daemon. Lives in its own file so
// app.ts stays under the 800-line gate.

import type { CitadelConfig } from "@citadel/config";
import type { SqliteStore } from "@citadel/db";
import { type AutoRecoveryMonitorHandle, type OperationService, startAutoRecoveryMonitor } from "@citadel/operations";
import { collectGitHubCiRuns, collectGitHubVersionControlSummary } from "@citadel/providers";
import { FIX_CI_PROMPT, decideAutoRecoveryAction } from "./auto-recovery.js";

export type AutoRecoveryWiringDeps = {
  store: SqliteStore;
  config: CitadelConfig;
  operations: OperationService;
  emit: (event: string, payload: unknown) => void;
};

// Parse env knobs once at startup. Caller may override defaults; the env-var
// surface is documented in specs/B.7 and acts as the operator escape hatch
// until packages/config grows first-class fields.
function readEnvKnobs() {
  const disabled = process.env.CITADEL_AUTO_RECOVERY_DISABLED === "1";
  const idleThresholdMs = parsePositiveInt(process.env.CITADEL_AUTO_RECOVERY_IDLE_MS, 5 * 60 * 1000);
  const debounceMs = parsePositiveInt(process.env.CITADEL_AUTO_RECOVERY_DEBOUNCE_MS, 30 * 60 * 1000);
  const intervalMs = parsePositiveInt(process.env.CITADEL_AUTO_RECOVERY_INTERVAL_MS, 60 * 1000);
  return { disabled, idleThresholdMs, debounceMs, intervalMs };
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function startDaemonAutoRecoveryMonitor(deps: AutoRecoveryWiringDeps): AutoRecoveryMonitorHandle | null {
  const knobs = readEnvKnobs();
  if (knobs.disabled) return null;
  return startAutoRecoveryMonitor(
    {
      store: deps.store,
      config: deps.config,
      decide: decideAutoRecoveryAction,
      // No caching here — the monitor runs at most every interval (default
      // 60s) and the gh rate-limit is generous at that cadence. If we later
      // shorten the interval we can wrap these in cachedProvider.
      fetchVersionControl: (workspacePath) => collectGitHubVersionControlSummary(workspacePath),
      fetchCi: (workspacePath) => collectGitHubCiRuns(workspacePath),
      spawnAutoRecoveryAgent: async ({ workspaceId, runtimeId, prompt }) => {
        const runtime = deps.config.runtimes.find((candidate) => candidate.id === runtimeId);
        if (!runtime) throw new Error(`runtime_not_found:${runtimeId}`);
        const session = await deps.operations.createAgentSession(
          {
            workspaceId,
            runtimeId: runtime.id,
            displayName: "Fix CI",
            prompt,
          },
          {
            command: runtime.command,
            args: runtime.args,
            displayName: runtime.displayName,
            promptArg: runtime.promptArg ?? null,
          },
          { activitySource: "automatic-rule" },
        );
        deps.emit("agent.updated", { workspaceId: session.workspaceId, sessionId: session.id });
        return { id: session.id };
      },
      prompt: FIX_CI_PROMPT,
      idleThresholdMs: knobs.idleThresholdMs,
      debounceMs: knobs.debounceMs,
      disabled: knobs.disabled,
    },
    knobs.intervalMs,
  );
}
