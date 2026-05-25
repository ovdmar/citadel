// Refresh provider data when the operator focuses the cockpit window, but
// only when the cached data is older than a threshold. The threshold lives
// in config.providerRefresh.focusRefreshThresholdMs (default 30s) — frequent
// alt-tabs don't thrash, while a window left in the background for minutes
// gets fresh data the moment the operator returns to it.

import type { QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

export type FocusRefreshOptions = {
  workspaceId: string | null | undefined;
  thresholdMs: number;
  queryClient: QueryClient;
  // Inject `now` for tests; defaults to Date.now.
  now?: () => number;
};

/**
 * Pure DOM-installer for the focus-refresh contract. Exported so tests can
 * call it without a React render harness. Returns a cleanup function.
 */
export function installFocusRefresh(opts: FocusRefreshOptions): () => void {
  const { workspaceId, thresholdMs, queryClient } = opts;
  if (!workspaceId) return () => {};
  const clock = opts.now ?? (() => Date.now());
  const onFocus = () => {
    const state = queryClient.getQueryState(["workspace-cockpit", workspaceId]);
    const dataUpdatedAt = state?.dataUpdatedAt ?? 0;
    if (clock() - dataUpdatedAt <= thresholdMs) return;
    void queryClient.invalidateQueries({ queryKey: ["workspace-cockpit", workspaceId] });
    void queryClient.invalidateQueries({ queryKey: ["workspaces-pr-state"] });
  };
  const onVisibilityChange = () => {
    if (typeof document !== "undefined" && document.visibilityState === "visible") onFocus();
  };
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onVisibilityChange);
  return () => {
    window.removeEventListener("focus", onFocus);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}

export function useFocusRefresh(opts: FocusRefreshOptions): void {
  const { workspaceId, thresholdMs, queryClient, now } = opts;
  useEffect(() => {
    return installFocusRefresh({ workspaceId, thresholdMs, queryClient, now });
  }, [workspaceId, thresholdMs, queryClient, now]);
}
