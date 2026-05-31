import type { PullRequestSummary, Workspace, WorkspaceCockpitSummary } from "@citadel/contracts";
import type { WorkspaceCockpitSummaryBatchResponse } from "@citadel/contracts/pr-routes";
import type { QueryClient } from "@tanstack/react-query";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo, useRef } from "react";
import { api } from "./api.js";

export { RuntimeLauncher, WorkspaceForm } from "./workspace-forms.js";

// Single-workspace summary. Freshness is driven by the 60s batch poll, focus,
// and SSE invalidation; placeholderData keeps workspace switches instant.
export function useWorkspaceCockpitSummary(
  workspace: Workspace | null,
  placeholderSummary?: WorkspaceCockpitSummary | undefined,
) {
  return useQuery(workspaceCockpitSummaryQueryOptions(workspace, placeholderSummary));
}

export function workspaceCockpitSummaryQueryOptions(
  workspace: Workspace | null,
  placeholderSummary?: WorkspaceCockpitSummary | undefined,
) {
  return {
    queryKey: ["workspace-cockpit", workspace?.id],
    enabled: Boolean(workspace),
    refetchOnWindowFocus: true,
    queryFn: () => api<WorkspaceCockpitSummary>(`/api/workspaces/${workspace?.id}/cockpit-summary`),
    // Conditional spread — exactOptionalPropertyTypes disallows passing
    // `undefined` explicitly, but omitting the key is fine.
    ...(placeholderSummary ? { placeholderData: placeholderSummary } : {}),
  };
}

export function invalidateActiveWorkspaceFromBatch(
  queryClient: Pick<QueryClient, "invalidateQueries">,
  activeWorkspaceId: string | null | undefined,
  dataUpdatedAt: number,
) {
  if (!activeWorkspaceId || dataUpdatedAt === 0) return;
  queryClient.invalidateQueries({ queryKey: ["workspace-cockpit", activeWorkspaceId] });
}

// Client-side filtering: only root workspaces are dropped here. The daemon
// decides remote-less and returns a {ok:false, reason:"no-remote"} envelope
// without spawning gh — the client just consumes it.
export function filterPollableWorkspaceIds(workspaces: Workspace[]) {
  return workspaces.filter((workspace) => workspace.kind !== "root").map((workspace) => workspace.id);
}

// Decide the batch poll's refetch interval. Pauses when the cockpit tab is
// hidden so the daemon doesn't burn gh subprocesses while the user is away.
// Returning `false` from refetchInterval (react-query v5) pauses polling.
export function nextPollInterval(visibilityState: "visible" | "hidden" | undefined): 60_000 | false {
  if (visibilityState === "hidden") return false;
  // Bumped from 30s → 60s. The daemon's per-PR adaptive scheduler decides
  // whether to actually call gh; polling at 60s lines up with the default
  // scheduler cadence + cache TTL so steady-state load is one round trip
  // per minute per workspace.
  return 60_000;
}

// Always-on cross-workspace PR poll. Stable queryKey so workspace adds/removes
// don't flash placeholders; placeholderData: keepPreviousData (v5 syntax —
// `keepPreviousData: true` is v4 and silently no-ops here) holds the previous
// map until the new fetch resolves. refetchOnWindowFocus resumes immediately
// on tab focus.
export function useAllWorkspacesPrSummary(workspaces: Workspace[]) {
  const filteredIds = filterPollableWorkspaceIds(workspaces);
  return useQuery({
    queryKey: ["workspaces-pr-batch"],
    enabled: filteredIds.length > 0,
    refetchInterval: () => nextPollInterval(typeof document === "undefined" ? "visible" : document.visibilityState),
    refetchOnWindowFocus: true,
    placeholderData: keepPreviousData,
    queryFn: () =>
      api<WorkspaceCockpitSummaryBatchResponse>("/api/workspaces/cockpit-summary/batch", {
        method: "POST",
        body: JSON.stringify({ ids: filteredIds }),
      }),
  });
}

// Authoritative ok:false reasons mean "this workspace truly has no PR data
// to cache" — clear the sticky entry. Any other reason (transient batch
// failure, gh hiccup, network blip) is non-authoritative: leave the cached
// entry untouched so the navbar keeps showing the last-known PR icon.
const AUTHORITATIVE_EMPTY_REASONS = new Set(["no-remote", "root-workspace", "workspace_not_found"]);

// Apply a batch onto a sticky cache. Pulled out so the merge rules can be
// unit-tested without React.
//
// Update rules:
//  - ok:true with versionControl.status === "healthy" — definitive update,
//    overwrites the cached entry (a null pullRequest in a healthy response
//    means "the PR was closed/merged or the branch genuinely has none").
//  - ok:true with versionControl.status === "degraded" — non-authoritative
//    (the provider couldn't talk to gh cleanly), so we KEEP the previous
//    entry to avoid the navbar's "PR state disappeared" flicker.
//  - ok:false with an authoritative reason — clear the entry.
//  - ok:false otherwise — keep the previous entry.
// Workspaces that are no longer in `knownIds` are pruned so the cache
// doesn't grow without bound across the cockpit's lifetime.
export function applyStickyUpdates(
  cache: Map<string, WorkspaceCockpitSummary>,
  knownIds: Set<string>,
  batch: WorkspaceCockpitSummaryBatchResponse | undefined,
): Map<string, WorkspaceCockpitSummary> {
  if (batch) {
    for (const entry of batch.summaries) {
      if (entry.ok) {
        // The contract types `summary` as unknown to avoid a cross-file zod
        // cycle (see packages/contracts/src/pr-routes.ts). The daemon writes
        // a real WorkspaceCockpitSummary — cast it back here.
        const summary = entry.summary as WorkspaceCockpitSummary;
        if (summary.versionControl.status === "healthy") {
          cache.set(entry.workspaceId, summary);
        } else if (summary.versionControl.cooldownUntil && cache.has(entry.workspaceId)) {
          // Degraded response carrying an active gh cooldown — merge cooldownUntil
          // onto the previous healthy entry so the banner has a data source even
          // when the daemon's vc: cache was empty at cooldown time. We do NOT
          // overwrite the previous pullRequest / reviewers / checks shape — those
          // come from the last healthy fetch and the operator wants to see them.
          const previous = cache.get(entry.workspaceId);
          if (previous) {
            cache.set(entry.workspaceId, {
              ...previous,
              versionControl: {
                ...previous.versionControl,
                cooldownUntil: summary.versionControl.cooldownUntil,
              },
            });
          }
        }
      } else if (AUTHORITATIVE_EMPTY_REASONS.has(entry.reason)) {
        cache.delete(entry.workspaceId);
      }
    }
  }
  for (const id of Array.from(cache.keys())) {
    if (!knownIds.has(id)) cache.delete(id);
  }
  return cache;
}

// Sticky per-workspace summary cache that survives transient batch failures.
// The returned Map identity is stable across renders (we mutate the same ref);
// callers must derive memoized views from it rather than relying on reference
// equality.
export function useStickyWorkspaceSummaries(
  workspaces: Workspace[],
  batch: WorkspaceCockpitSummaryBatchResponse | undefined,
): Map<string, WorkspaceCockpitSummary> {
  const cacheRef = useRef(new Map<string, WorkspaceCockpitSummary>());
  // Stable id key — derived from sorted ids so the downstream memo only re-runs
  // when the workspace set actually changes (the `workspaces` array gets a
  // fresh identity on every parent re-render).
  const idsKey = useMemo(
    () =>
      workspaces
        .map((w) => w.id)
        .sort()
        .join("\n"),
    [workspaces],
  );
  return useMemo(() => {
    const knownIds = new Set(idsKey ? idsKey.split("\n") : []);
    applyStickyUpdates(cacheRef.current, knownIds, batch);
    return cacheRef.current;
  }, [batch, idsKey]);
}

// Derive a PR map from the sticky summary cache. Used by the navbar /
// command palette so they don't need to know about the summary shape.
export function prMapFromSummaries(
  summaries: Map<string, WorkspaceCockpitSummary>,
): Map<string, PullRequestSummary | null> {
  const map = new Map<string, PullRequestSummary | null>();
  for (const [id, summary] of summaries) {
    map.set(id, summary.versionControl.pullRequest ?? null);
  }
  return map;
}

// Find the soonest active gh-cooldown ISO timestamp across every workspace's
// versionControl.cooldownUntil. Returns null when no cooldown is active.
// "Active" = the ISO parses to a future time relative to `now`. Used by the
// top-of-cockpit banner so the operator sees "GitHub rate-limited — retrying
// at HH:MM" instead of an opaque generic-degraded state.
export function selectActiveGhCooldown(
  summaries: Map<string, WorkspaceCockpitSummary>,
  now: number = Date.now(),
): { until: number; iso: string } | null {
  let soonest: { until: number; iso: string } | null = null;
  for (const summary of summaries.values()) {
    const iso = summary.versionControl.cooldownUntil;
    if (!iso) continue;
    const until = Date.parse(iso);
    if (!Number.isFinite(until) || until <= now) continue;
    if (!soonest || until < soonest.until) soonest = { until, iso };
  }
  return soonest;
}
