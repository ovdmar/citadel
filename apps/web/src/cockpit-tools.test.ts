// @vitest-environment happy-dom

import type { PullRequestSummary, Workspace, WorkspaceCockpitSummary } from "@citadel/contracts";
import type { WorkspaceCockpitSummaryBatchResponse } from "@citadel/contracts/pr-routes";
import { QueryClient } from "@tanstack/react-query";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  type StickyWorkspaceSummaries,
  applyStickyUpdates,
  filterPollableWorkspaceIds,
  invalidateActiveWorkspaceFromBatch,
  markPullRequestMerged,
  markWorkspacePrMergedInQueryCache,
  nextPollInterval,
  prMapFromSummaries,
  selectActiveGhCooldown,
  useStickyWorkspaceSummaries,
  workspaceCockpitSummaryQueryOptions,
} from "./cockpit-tools.js";

const roots: Root[] = [];

afterEach(() => {
  flushSync(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
});

const workspace = (overrides: Partial<Workspace>): Workspace =>
  ({
    id: "ws_test",
    repoId: "repo_test",
    name: "Test",
    path: "/tmp/repo",
    branch: "feature",
    baseBranch: "main",
    source: "scratch",
    kind: "worktree",
    prUrl: null,
    issueKey: null,
    issueTitle: null,
    issueUrl: null,
    slackThreadUrl: null,
    section: "backlog",
    pinned: false,
    lifecycle: "ready",
    dirty: false,
    namespaceId: null,
    createdAt: "2026-05-01T00:00:00Z",
    updatedAt: "2026-05-01T00:00:00Z",
    archivedAt: null,
    ...overrides,
  }) as Workspace;

const makePr = (overrides: Partial<PullRequestSummary> = {}): PullRequestSummary => ({
  number: 42,
  title: "Test",
  url: "https://x.test/pr/42",
  state: "OPEN",
  draft: false,
  reviewDecision: null,
  checks: [],
  additions: 12,
  deletions: 3,
  reviewers: [],
  commits: [],
  headRefName: "feature",
  parentPr: null,
  mergeable: "unknown",
  allowedMergeStrategies: [],
  mergeStateStatus: null,
  headSha: null,
  ...overrides,
});

const makeSummary = (
  id: string,
  status: "healthy" | "degraded",
  pr: PullRequestSummary | null = null,
  cooldownUntil: string | null = null,
): WorkspaceCockpitSummary =>
  ({
    workspaceId: id,
    readiness: { tone: "idle", label: "ready" },
    git: { clean: true, ahead: 0, behind: 0 },
    versionControl: {
      providerId: "github-gh",
      status,
      reason: status === "degraded" ? "gh timed out" : null,
      defaultBranch: "main",
      currentBranch: "feature",
      remotes: ["origin"],
      pullRequest: pr,
      checkedAt: new Date().toISOString(),
      ...(cooldownUntil !== null ? { cooldownUntil } : {}),
    },
    ci: { providerId: "github-gh", status: "healthy", reason: null, runs: [], checkedAt: new Date().toISOString() },
    issueTracker: null,
    apps: { applications: [] },
  }) as unknown as WorkspaceCockpitSummary;

describe("filterPollableWorkspaceIds", () => {
  it("drops root-kind workspaces so the daemon doesn't waste gh spawns on them", () => {
    expect(
      filterPollableWorkspaceIds([
        workspace({ id: "ws_a", kind: "worktree" }),
        workspace({ id: "ws_root", kind: "root" }),
        workspace({ id: "ws_b", kind: "worktree" }),
      ]),
    ).toEqual(["ws_a", "ws_b"]);
  });

  it("returns an empty list when every workspace is root — react-query then disables the poll", () => {
    expect(
      filterPollableWorkspaceIds([workspace({ id: "ws_r1", kind: "root" }), workspace({ id: "ws_r2", kind: "root" })]),
    ).toEqual([]);
  });
});

describe("nextPollInterval", () => {
  it("polls every 60s when the tab is visible", () => {
    expect(nextPollInterval("visible")).toBe(60_000);
  });

  it("returns false (pause) when the tab is hidden so daemon spawn pressure goes to zero", () => {
    expect(nextPollInterval("hidden")).toBe(false);
  });

  it("falls back to polling when visibilityState is undefined (non-browser host)", () => {
    expect(nextPollInterval(undefined)).toBe(60_000);
  });
});

describe("workspaceCockpitSummaryQueryOptions", () => {
  it("does not install an active-workspace polling interval", () => {
    const options = workspaceCockpitSummaryQueryOptions(workspace({ id: "ws_a" }));

    expect("refetchInterval" in options).toBe(false);
    expect(options.refetchOnWindowFocus).toBe(true);
  });

  it("keeps placeholder data available on mount", () => {
    const placeholder = makeSummary("ws_a", "healthy", makePr({ number: 7 }));
    const options = workspaceCockpitSummaryQueryOptions(workspace({ id: "ws_a" }), placeholder);

    expect(options.placeholderData).toBe(placeholder);
  });
});

describe("invalidateActiveWorkspaceFromBatch", () => {
  it("invalidates the active workspace when a batch result lands", () => {
    const calls: unknown[] = [];
    invalidateActiveWorkspaceFromBatch(
      { invalidateQueries: (input: unknown) => calls.push(input) } as never,
      "ws_a",
      123,
    );

    expect(calls).toEqual([{ queryKey: ["workspace-cockpit", "ws_a"] }]);
  });

  it("skips the initial zero timestamp and missing active workspace", () => {
    const calls: unknown[] = [];
    const queryClient = { invalidateQueries: (input: unknown) => calls.push(input) } as never;

    invalidateActiveWorkspaceFromBatch(queryClient, "ws_a", 0);
    invalidateActiveWorkspaceFromBatch(queryClient, null, 123);

    expect(calls).toEqual([]);
  });
});

describe("applyStickyUpdates", () => {
  it("writes healthy summaries into the cache", () => {
    const cache = new Map<string, WorkspaceCockpitSummary>();
    const summary = makeSummary("ws_a", "healthy", makePr({ number: 7 }));
    const batch: WorkspaceCockpitSummaryBatchResponse = {
      summaries: [{ workspaceId: "ws_a", ok: true, summary }],
    };
    applyStickyUpdates(cache, new Set(["ws_a"]), batch);
    expect(cache.get("ws_a")?.versionControl.pullRequest?.number).toBe(7);
  });

  it("preserves the previous entry when a refetch returns a degraded summary (transient gh failure)", () => {
    const cache = new Map<string, WorkspaceCockpitSummary>();
    cache.set("ws_a", makeSummary("ws_a", "healthy", makePr({ number: 7 })));
    const batch: WorkspaceCockpitSummaryBatchResponse = {
      summaries: [{ workspaceId: "ws_a", ok: true, summary: makeSummary("ws_a", "degraded", null) }],
    };
    applyStickyUpdates(cache, new Set(["ws_a"]), batch);
    // Sticky cache must NOT drop the known-good PR just because gh blipped.
    expect(cache.get("ws_a")?.versionControl.pullRequest?.number).toBe(7);
  });

  it("preserves the previous entry on non-authoritative ok:false reasons", () => {
    const cache = new Map<string, WorkspaceCockpitSummary>();
    cache.set("ws_a", makeSummary("ws_a", "healthy", makePr({ number: 7 })));
    const batch: WorkspaceCockpitSummaryBatchResponse = {
      summaries: [{ workspaceId: "ws_a", ok: false, reason: "summary_failed" }],
    };
    applyStickyUpdates(cache, new Set(["ws_a"]), batch);
    expect(cache.get("ws_a")?.versionControl.pullRequest?.number).toBe(7);
  });

  it("clears the entry on authoritative ok:false reasons", () => {
    const cache = new Map<string, WorkspaceCockpitSummary>();
    cache.set("ws_a", makeSummary("ws_a", "healthy", makePr({ number: 7 })));
    const batch: WorkspaceCockpitSummaryBatchResponse = {
      summaries: [
        { workspaceId: "ws_a", ok: false, reason: "no-remote" },
        { workspaceId: "ws_b", ok: false, reason: "root-workspace" },
        { workspaceId: "ws_c", ok: false, reason: "workspace_not_found" },
      ],
    };
    cache.set("ws_b", makeSummary("ws_b", "healthy", makePr()));
    cache.set("ws_c", makeSummary("ws_c", "healthy", makePr()));
    applyStickyUpdates(cache, new Set(["ws_a", "ws_b", "ws_c"]), batch);
    expect(cache.has("ws_a")).toBe(false);
    expect(cache.has("ws_b")).toBe(false);
    expect(cache.has("ws_c")).toBe(false);
  });

  it("overwrites with a healthy null pullRequest (PR closed/merged is authoritative)", () => {
    const cache = new Map<string, WorkspaceCockpitSummary>();
    cache.set("ws_a", makeSummary("ws_a", "healthy", makePr({ number: 7 })));
    const batch: WorkspaceCockpitSummaryBatchResponse = {
      summaries: [{ workspaceId: "ws_a", ok: true, summary: makeSummary("ws_a", "healthy", null) }],
    };
    applyStickyUpdates(cache, new Set(["ws_a"]), batch);
    expect(cache.get("ws_a")?.versionControl.pullRequest).toBeNull();
  });

  it("does not downgrade a locally-merged PR when a stale healthy open summary arrives", () => {
    const cache = new Map<string, WorkspaceCockpitSummary>();
    cache.set("ws_a", makeSummary("ws_a", "healthy", makePr({ number: 7, state: "MERGED" })));
    const batch: WorkspaceCockpitSummaryBatchResponse = {
      summaries: [{ workspaceId: "ws_a", ok: true, summary: makeSummary("ws_a", "healthy", makePr({ number: 7 })) }],
    };
    applyStickyUpdates(cache, new Set(["ws_a"]), batch);
    expect(cache.get("ws_a")?.versionControl.pullRequest?.state).toBe("MERGED");
  });

  it("prunes entries for workspaces that no longer exist", () => {
    const cache = new Map<string, WorkspaceCockpitSummary>();
    cache.set("ws_gone", makeSummary("ws_gone", "healthy", makePr()));
    cache.set("ws_kept", makeSummary("ws_kept", "healthy", makePr()));
    applyStickyUpdates(cache, new Set(["ws_kept"]), undefined);
    expect(cache.has("ws_gone")).toBe(false);
    expect(cache.has("ws_kept")).toBe(true);
  });
});

describe("prMapFromSummaries", () => {
  it("derives a PR map preserving additions/deletions for the navbar diff display", () => {
    const cache = new Map<string, WorkspaceCockpitSummary>();
    cache.set("ws_a", makeSummary("ws_a", "healthy", makePr({ additions: 88, deletions: 11 })));
    const map = prMapFromSummaries(cache);
    expect(map.get("ws_a")?.additions).toBe(88);
    expect(map.get("ws_a")?.deletions).toBe(11);
  });

  it("returns null for workspaces whose summary has no PR", () => {
    const cache = new Map<string, WorkspaceCockpitSummary>();
    cache.set("ws_nopr", makeSummary("ws_nopr", "healthy", null));
    expect(prMapFromSummaries(cache).get("ws_nopr")).toBeNull();
  });
});

describe("markWorkspacePrMergedInQueryCache", () => {
  it("marks active and batch PR summaries as merged while preserving PR stats", () => {
    const queryClient = new QueryClient();
    const summary = makeSummary(
      "ws_a",
      "healthy",
      makePr({ additions: 88, deletions: 11, mergeable: "mergeable", allowedMergeStrategies: ["squash"] }),
    );
    queryClient.setQueryData(["workspace-cockpit", "ws_a"], summary);
    queryClient.setQueryData<WorkspaceCockpitSummaryBatchResponse>(["workspaces-pr-batch"], {
      summaries: [
        { workspaceId: "ws_a", ok: true, summary },
        { workspaceId: "ws_b", ok: true, summary: makeSummary("ws_b", "healthy", makePr({ number: 9 })) },
      ],
    });

    markWorkspacePrMergedInQueryCache(queryClient, "ws_a", 42);

    const active = queryClient.getQueryData<WorkspaceCockpitSummary>(["workspace-cockpit", "ws_a"]);
    expect(active?.versionControl.pullRequest).toMatchObject({
      number: 42,
      state: "MERGED",
      additions: 88,
      deletions: 11,
      mergeable: "unknown",
      allowedMergeStrategies: [],
      mergeStateStatus: null,
    });

    const batch = queryClient.getQueryData<WorkspaceCockpitSummaryBatchResponse>(["workspaces-pr-batch"]);
    const wsA = batch?.summaries.find((entry) => entry.workspaceId === "ws_a" && entry.ok);
    const wsB = batch?.summaries.find((entry) => entry.workspaceId === "ws_b" && entry.ok);
    const wsASummary = (wsA?.ok ? wsA.summary : null) as WorkspaceCockpitSummary | null;
    const wsBSummary = (wsB?.ok ? wsB.summary : null) as WorkspaceCockpitSummary | null;
    expect(wsASummary?.versionControl.pullRequest?.state).toBe("MERGED");
    expect(wsBSummary?.versionControl.pullRequest?.state).toBe("OPEN");
  });

  it("leaves unrelated PR numbers unchanged", () => {
    const pr = makePr({ number: 7 });
    expect(markPullRequestMerged(pr).state).toBe("MERGED");

    const queryClient = new QueryClient();
    const summary = makeSummary("ws_a", "healthy", pr);
    queryClient.setQueryData(["workspace-cockpit", "ws_a"], summary);

    markWorkspacePrMergedInQueryCache(queryClient, "ws_a", 42);

    expect(
      queryClient.getQueryData<WorkspaceCockpitSummary>(["workspace-cockpit", "ws_a"])?.versionControl.pullRequest
        ?.state,
    ).toBe("OPEN");
  });
});

describe("useStickyWorkspaceSummaries", () => {
  it("returns a fresh snapshot when the background batch mutates the sticky cache", async () => {
    const ws = workspace({ id: "ws_a" });
    const harness = await renderStickyHarness({ workspaces: [ws], batch: undefined });
    const initial = harness.latest().summaries;
    expect(initial.has("ws_a")).toBe(false);

    const summary = makeSummary("ws_a", "healthy", makePr({ number: 7 }));
    await harness.rerender({
      workspaces: [ws],
      batch: { summaries: [{ workspaceId: "ws_a", ok: true, summary }] },
    });

    const next = harness.latest().summaries;
    expect(next).not.toBe(initial);
    expect(prMapFromSummaries(next).get("ws_a")?.number).toBe(7);
  });

  it("can remember the active workspace summary so navbar state survives selection changes", async () => {
    const ws = workspace({ id: "ws_active" });
    const harness = await renderStickyHarness({ workspaces: [ws], batch: undefined });

    const summary = makeSummary("ws_active", "healthy", makePr({ number: 8 }));
    flushSync(() => {
      harness.latest().rememberSummary(summary);
    });

    expect(prMapFromSummaries(harness.latest().summaries).get("ws_active")?.number).toBe(8);
  });
});

type StickyHarnessProps = {
  workspaces: Workspace[];
  batch: WorkspaceCockpitSummaryBatchResponse | undefined;
};

async function renderStickyHarness(initialProps: StickyHarnessProps) {
  let latestValue: StickyWorkspaceSummaries | null = null;
  const rootElement = document.createElement("div");
  document.body.appendChild(rootElement);
  const root = createRoot(rootElement);
  roots.push(root);

  function Harness(props: StickyHarnessProps) {
    latestValue = useStickyWorkspaceSummaries(props.workspaces, props.batch);
    return null;
  }

  const render = async (props: StickyHarnessProps) => {
    flushSync(() => {
      root.render(createElement(Harness, props));
    });
  };

  await render(initialProps);

  return {
    latest: () => {
      if (!latestValue) throw new Error("sticky harness did not render");
      return latestValue;
    },
    rerender: render,
  };
}

describe("selectActiveGhCooldown", () => {
  it("returns null when no workspace carries a cooldownUntil", () => {
    const cache = new Map<string, WorkspaceCockpitSummary>();
    cache.set("ws_a", makeSummary("ws_a", "healthy", makePr()));
    expect(selectActiveGhCooldown(cache)).toBeNull();
  });

  it("returns null when cooldownUntil is in the past (stale, ignore)", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const cache = new Map<string, WorkspaceCockpitSummary>();
    cache.set("ws_a", makeSummary("ws_a", "degraded", null, past));
    expect(selectActiveGhCooldown(cache)).toBeNull();
  });

  it("returns the soonest active cooldownUntil across workspaces", () => {
    const now = Date.now();
    const soonerIso = new Date(now + 5 * 60_000).toISOString();
    const laterIso = new Date(now + 14 * 60_000).toISOString();
    const cache = new Map<string, WorkspaceCockpitSummary>();
    cache.set("ws_a", makeSummary("ws_a", "degraded", null, laterIso));
    cache.set("ws_b", makeSummary("ws_b", "degraded", null, soonerIso));
    cache.set("ws_c", makeSummary("ws_c", "healthy", makePr())); // no cooldown
    expect(selectActiveGhCooldown(cache, now)).toEqual({
      until: Date.parse(soonerIso),
      iso: soonerIso,
    });
  });

  it("skips invalid (unparseable) cooldownUntil values", () => {
    const cache = new Map<string, WorkspaceCockpitSummary>();
    cache.set("ws_a", makeSummary("ws_a", "degraded", null, "not-a-date"));
    expect(selectActiveGhCooldown(cache)).toBeNull();
  });
});

describe("applyStickyUpdates + cooldownUntil (R2 SUG-1)", () => {
  it("preserves cooldownUntil through a healthy cached entry", () => {
    const cache = new Map<string, WorkspaceCockpitSummary>();
    const cooldownIso = new Date(Date.now() + 10 * 60_000).toISOString();
    const summary = makeSummary("ws_a", "healthy", makePr({ number: 7 }), cooldownIso);
    const batch: WorkspaceCockpitSummaryBatchResponse = {
      summaries: [{ workspaceId: "ws_a", ok: true, summary }],
    };
    applyStickyUpdates(cache, new Set(["ws_a"]), batch);
    expect(cache.get("ws_a")?.versionControl.cooldownUntil).toBe(cooldownIso);
  });

  // Review #4 regression: a degraded response carrying cooldownUntil used to
  // be dropped entirely by the sticky cache, so the banner had no data
  // source when the daemon's vc: cache was empty at cooldown time. Now we
  // merge cooldownUntil onto the previous healthy entry.
  it("merges cooldownUntil onto the previous healthy entry when refetch returns degraded", () => {
    const cache = new Map<string, WorkspaceCockpitSummary>();
    cache.set("ws_a", makeSummary("ws_a", "healthy", makePr({ number: 7 })));
    const cooldownIso = new Date(Date.now() + 12 * 60_000).toISOString();
    const batch: WorkspaceCockpitSummaryBatchResponse = {
      summaries: [{ workspaceId: "ws_a", ok: true, summary: makeSummary("ws_a", "degraded", null, cooldownIso) }],
    };
    applyStickyUpdates(cache, new Set(["ws_a"]), batch);
    const entry = cache.get("ws_a");
    expect(entry?.versionControl.cooldownUntil).toBe(cooldownIso);
    // Previous pullRequest data is preserved — the operator keeps seeing the
    // last-known PR underneath the rate-limit banner.
    expect(entry?.versionControl.pullRequest?.number).toBe(7);
    expect(entry?.versionControl.status).toBe("healthy");
  });

  it("degraded without cooldownUntil still preserves the previous entry (no merge)", () => {
    const cache = new Map<string, WorkspaceCockpitSummary>();
    cache.set("ws_a", makeSummary("ws_a", "healthy", makePr({ number: 7 })));
    const batch: WorkspaceCockpitSummaryBatchResponse = {
      summaries: [{ workspaceId: "ws_a", ok: true, summary: makeSummary("ws_a", "degraded", null) }],
    };
    applyStickyUpdates(cache, new Set(["ws_a"]), batch);
    const entry = cache.get("ws_a");
    expect(entry?.versionControl.pullRequest?.number).toBe(7);
    expect(entry?.versionControl.cooldownUntil).toBeUndefined();
  });

  it("degraded with cooldownUntil but no prior cache entry is a no-op (nothing to merge onto)", () => {
    const cache = new Map<string, WorkspaceCockpitSummary>();
    const cooldownIso = new Date(Date.now() + 10 * 60_000).toISOString();
    const batch: WorkspaceCockpitSummaryBatchResponse = {
      summaries: [{ workspaceId: "ws_a", ok: true, summary: makeSummary("ws_a", "degraded", null, cooldownIso) }],
    };
    applyStickyUpdates(cache, new Set(["ws_a"]), batch);
    expect(cache.has("ws_a")).toBe(false);
  });
});
