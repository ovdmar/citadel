import { useMutation } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, queryClient } from "../api.js";
import { deployedAppsQueryKey, redeployPayload } from "../deployed-apps-target.js";
import {
  MIN_SPIN_MS,
  PREFETCH_TIMEOUT_MS,
  WATCHDOG_INTERVAL_MS,
  WATCHDOG_MAX_MS,
  classifyRedeployError,
  watchdogShouldClear,
} from "./use-redeploy-helpers.js";

type RedeployResponse = { operationId?: string };
type StatePayload = { daemonStartedAt?: string };

type UseRedeployResult = {
  inFlight: boolean;
  targetName: string | undefined;
  lastOperationId: string | null;
  error: Error | null;
  trigger: (name?: string) => void;
};

export function useRedeploy(workspaceId: string, checkoutId?: string | null): UseRedeployResult {
  const [inFlight, setInFlight] = useState(false);
  const [targetName, setTargetName] = useState<string | undefined>(undefined);
  const [lastOperationId, setLastOperationId] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);

  // Refs hold mutable state that must not trigger re-renders or block effect
  // cleanup. `aborted` is the canonical "this hook has unmounted" flag —
  // every state setter guards on it before firing.
  const aborted = useRef(false);
  const minSpinTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const watchdogInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const watchdogTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const minSpinElapsed = useRef(true);
  const mutationResolved = useRef(false);

  const clearTimers = useCallback(() => {
    if (minSpinTimer.current) clearTimeout(minSpinTimer.current);
    if (watchdogInterval.current) clearInterval(watchdogInterval.current);
    if (watchdogTimeout.current) clearTimeout(watchdogTimeout.current);
    minSpinTimer.current = null;
    watchdogInterval.current = null;
    watchdogTimeout.current = null;
  }, []);

  useEffect(() => {
    aborted.current = false;
    return () => {
      aborted.current = true;
      clearTimers();
    };
  }, [clearTimers]);

  const safeSet = useCallback(<T>(setter: (v: T) => void, value: T) => {
    if (!aborted.current) setter(value);
  }, []);

  const finishInFlight = useCallback(() => {
    safeSet(setInFlight, false);
    queryClient.invalidateQueries({ queryKey: deployedAppsQueryKey(workspaceId, checkoutId) });
  }, [safeSet, workspaceId, checkoutId]);

  const mutation = useMutation({
    mutationFn: (name?: string) =>
      api<RedeployResponse>(`/api/workspaces/${workspaceId}/deployed-apps/redeploy`, {
        method: "POST",
        body: JSON.stringify(redeployPayload(name, checkoutId)),
      }),
  });

  const startWatchdog = useCallback(
    (preToken: string | null) => {
      const poll = async () => {
        try {
          // AbortSignal.timeout keeps each poll bounded; fetch will reject
          // with an AbortError that we silently swallow (next tick polls).
          const state = await api<StatePayload>("/api/state", {
            signal: AbortSignal.timeout(WATCHDOG_INTERVAL_MS),
          });
          if (aborted.current) return;
          if (watchdogShouldClear(preToken, state.daemonStartedAt)) {
            clearTimers();
            finishInFlight();
          }
        } catch {
          // Network errors during watchdog poll are expected (daemon mid-restart).
        }
      };
      watchdogInterval.current = setInterval(poll, WATCHDOG_INTERVAL_MS);
      watchdogTimeout.current = setTimeout(() => {
        clearTimers();
        if (aborted.current) return;
        // Cap reached. Clear the spinner and surface a non-blocking warning.
        // The operator can check the operations log directly.
        console.warn(
          "[redeploy] watchdog timed out — daemon did not return a newer daemonStartedAt within WATCHDOG_MAX_MS",
        );
        finishInFlight();
      }, WATCHDOG_MAX_MS);
    },
    [clearTimers, finishInFlight],
  );

  const trigger = useCallback(
    (name?: string) => {
      if (inFlight) return; // double-tap guard at the hook level
      safeSet(setTargetName, name);
      safeSet(setLastOperationId, null);
      safeSet(setError, null);
      safeSet(setInFlight, true);
      mutationResolved.current = false;
      minSpinElapsed.current = false;
      clearTimers();
      minSpinTimer.current = setTimeout(() => {
        minSpinElapsed.current = true;
        if (aborted.current) return;
        // Only finish if the mutation has resolved successfully. Errors and
        // the watchdog path manage their own clearing.
        if (mutationResolved.current) finishInFlight();
      }, MIN_SPIN_MS);

      (async () => {
        // Always-fresh pre-fetch — cached query value may be arbitrarily
        // stale. Bound by AbortSignal.timeout so spinner-on isn't delayed.
        let preToken: string | null = null;
        try {
          const pre = await api<StatePayload>("/api/state", {
            signal: AbortSignal.timeout(PREFETCH_TIMEOUT_MS),
          });
          preToken = pre.daemonStartedAt ?? null;
        } catch {
          preToken = null;
        }
        if (aborted.current) return;

        try {
          const result = await mutation.mutateAsync(name);
          if (aborted.current) return;
          mutationResolved.current = true;
          safeSet(setLastOperationId, result?.operationId ?? null);
          if (minSpinElapsed.current) finishInFlight();
        } catch (caught) {
          if (aborted.current) return;
          const kind = classifyRedeployError(caught);
          if (kind === "network") {
            // Daemon likely restarting itself — fall into watchdog mode.
            startWatchdog(preToken);
          } else {
            const err = caught instanceof Error ? caught : new Error(String(caught));
            safeSet(setError, err);
            // Honest error: clear immediately (no MIN_SPIN_MS floor masking).
            clearTimers();
            finishInFlight();
          }
        }
      })();
    },
    [clearTimers, finishInFlight, inFlight, mutation, safeSet, startWatchdog],
  );

  return { inFlight, targetName, lastOperationId, error, trigger };
}
