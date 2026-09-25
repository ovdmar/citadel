// @vitest-environment happy-dom
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installFocusRefresh } from "./use-focus-refresh.js";

const wsId = "ws_demo";

function seedCockpitState(client: QueryClient, dataUpdatedAtMs: number) {
  client.setQueryData(["workspace-cockpit", wsId], { workspaceId: wsId });
  const state = client.getQueryState(["workspace-cockpit", wsId]);
  if (!state) throw new Error("query state missing");
  (state as { dataUpdatedAt: number }).dataUpdatedAt = dataUpdatedAtMs;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("installFocusRefresh", () => {
  it("does not invalidate when data is fresher than threshold", () => {
    const client = new QueryClient();
    const now = 1_000_000;
    seedCockpitState(client, now - 5_000); // 5s old, threshold 30s
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const cleanup = installFocusRefresh({
      workspaceId: wsId,
      thresholdMs: 30_000,
      queryClient: client,
      now: () => now,
    });
    window.dispatchEvent(new Event("focus"));
    expect(invalidate).not.toHaveBeenCalled();
    cleanup();
  });

  it("invalidates cockpit and workspace PR queries when data is older than threshold and focus fires", () => {
    const client = new QueryClient();
    const now = 1_000_000;
    seedCockpitState(client, now - 60_000); // 60s old, threshold 30s
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const cleanup = installFocusRefresh({
      workspaceId: wsId,
      thresholdMs: 30_000,
      queryClient: client,
      now: () => now,
    });
    window.dispatchEvent(new Event("focus"));
    const keys = invalidate.mock.calls.map((c) => JSON.stringify((c[0] as { queryKey: unknown[] }).queryKey));
    expect(keys).toContain(JSON.stringify(["workspace-cockpit", wsId]));
    expect(keys).toContain(JSON.stringify(["workspaces-pr-state"]));
    expect(keys).toContain(JSON.stringify(["workspaces-pr-batch"]));
    cleanup();
  });

  it("invalidates when visibilitychange fires and document is visible", () => {
    const client = new QueryClient();
    const now = 1_000_000;
    seedCockpitState(client, now - 60_000);
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const cleanup = installFocusRefresh({
      workspaceId: wsId,
      thresholdMs: 30_000,
      queryClient: client,
      now: () => now,
    });
    // happy-dom defaults document.visibilityState to "visible".
    document.dispatchEvent(new Event("visibilitychange"));
    expect(invalidate).toHaveBeenCalled();
    cleanup();
  });

  it("does nothing when there is no active workspace", () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const cleanup = installFocusRefresh({ workspaceId: null, thresholdMs: 30_000, queryClient: client });
    window.dispatchEvent(new Event("focus"));
    expect(invalidate).not.toHaveBeenCalled();
    cleanup();
  });

  it("cleanup removes both event listeners", () => {
    const client = new QueryClient();
    const now = 1_000_000;
    seedCockpitState(client, now - 60_000);
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const cleanup = installFocusRefresh({
      workspaceId: wsId,
      thresholdMs: 30_000,
      queryClient: client,
      now: () => now,
    });
    cleanup();
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(invalidate).not.toHaveBeenCalled();
  });
});
