// Wires the @citadel/operations auto-resume loop with daemon I/O. Kept out
// of app.ts so that file stays close to the 800-line gate. See
// packages/operations/src/auto-resume.ts for the loop semantics; this file
// just supplies the store-backed list/update + sendAgentMessage adapter.

import type { CitadelConfig } from "@citadel/config";
import type { SqliteStore } from "@citadel/db";
import {
  type AutoResumeLoopHandle,
  DEFAULT_AUTO_RESUME_INTERVAL_MS,
  type OperationService,
  deriveAccountUsageLimit,
  startAutoResumeLoop,
} from "@citadel/operations";
import { listRuntimeHealth } from "@citadel/runtimes";

export function startDaemonAutoResumeLoop(
  store: SqliteStore,
  operations: OperationService,
  config?: Pick<CitadelConfig, "runtimes">,
): AutoResumeLoopHandle | null {
  if (process.env.CITADEL_DISABLE_AUTO_RESUME === "1") return null;
  const intervalEnv = Number(process.env.CITADEL_AUTO_RESUME_INTERVAL_MS);
  const intervalMs = Number.isFinite(intervalEnv) && intervalEnv > 0 ? intervalEnv : DEFAULT_AUTO_RESUME_INTERVAL_MS;
  const runtimeIsHealthy = (runtimeId: string) => isRuntimeHealthy(config, runtimeId);
  return startAutoResumeLoop(
    {
      now: () => new Date(),
      listSessions: () => store.listSessions(),
      sendAgentMessage: (input) =>
        operations.sendAgentMessage({
          sessionId: input.sessionId,
          message: input.message,
          ...(input.source !== undefined ? { source: input.source } : {}),
          ...(input.optimistic !== undefined ? { optimistic: input.optimistic } : {}),
        }),
      updateRateLimitResume: (sessionId, update) => store.updateSessionRateLimitResume(sessionId, update),
      isAccountRateLimited: () => {
        const sessions = store.listSessions();
        if (!config) return deriveAccountUsageLimit(sessions, new Date());
        const healthByRuntimeId = new Map(listRuntimeHealth(config.runtimes).map((runtime) => [runtime.id, runtime]));
        return deriveAccountUsageLimit(
          sessions.filter((session) => healthByRuntimeId.get(session.runtimeId)?.health === "healthy"),
          new Date(),
        );
      },
      isRuntimeHealthy: runtimeIsHealthy,
      logger: {
        warn: (msg, meta) => {
          // eslint-disable-next-line no-console
          console.warn(msg, meta ?? "");
        },
      },
    },
    intervalMs,
  );
}

function isRuntimeHealthy(config: Pick<CitadelConfig, "runtimes"> | undefined, runtimeId: string): boolean {
  if (!config) return true;
  return listRuntimeHealth(config.runtimes).find((runtime) => runtime.id === runtimeId)?.health === "healthy";
}
