import type { CitadelConfig } from "@citadel/config";
import { collectSystemHealthSnapshot } from "./system-health.js";

export const SYSTEM_HEALTH_EVENT_INTERVAL_MS = 5_000;
export const SYSTEM_HEALTH_UPDATED_EVENT = "system-health.updated";

export function startSystemHealthEvents(input: {
  config: CitadelConfig;
  emit: (type: string, payload: unknown) => void;
  hasViewers: () => boolean;
  intervalMs?: number;
  collect?: typeof collectSystemHealthSnapshot;
}): { stop: () => void; tick: () => void } {
  const collect = input.collect ?? collectSystemHealthSnapshot;
  let stopped = false;
  const tick = () => {
    if (stopped || !input.hasViewers()) return;
    input.emit(SYSTEM_HEALTH_UPDATED_EVENT, collect({ diskPath: input.config.dataDir }));
  };

  const timer = setInterval(tick, input.intervalMs ?? SYSTEM_HEALTH_EVENT_INTERVAL_MS);
  if (typeof timer === "object" && "unref" in timer) timer.unref();

  return {
    tick,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
