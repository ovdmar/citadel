import type express from "express";
import { describe, expect, it, vi } from "vitest";
import { parseGitHubFullName, wireGhQuota } from "./gh-quota-wiring.js";

describe("parseGitHubFullName", () => {
  it("parses SSH form (git@github.com:owner/repo.git)", () => {
    expect(parseGitHubFullName("git@github.com:ovdmar/citadel.git")).toBe("ovdmar/citadel");
  });

  it("parses SSH form without .git suffix", () => {
    expect(parseGitHubFullName("git@github.com:ovdmar/citadel")).toBe("ovdmar/citadel");
  });

  it("parses HTTPS form", () => {
    expect(parseGitHubFullName("https://github.com/ovdmar/citadel.git")).toBe("ovdmar/citadel");
  });

  it("parses HTTPS without .git", () => {
    expect(parseGitHubFullName("https://github.com/ovdmar/citadel")).toBe("ovdmar/citadel");
  });

  it("parses HTTPS with trailing slash", () => {
    expect(parseGitHubFullName("https://github.com/ovdmar/citadel/")).toBe("ovdmar/citadel");
  });

  it("returns null for non-GitHub URL", () => {
    expect(parseGitHubFullName("https://example.com")).toBeNull();
    expect(parseGitHubFullName("not-a-url")).toBeNull();
  });
});

describe("wireGhQuota — viewer-gate helpers", () => {
  function makeStubStore() {
    return {
      listWorkspaces: () => [],
      listRepos: () => [],
      getWorkspacePrSnapshot: () => null,
    } as never;
  }

  it("hasViewers reflects sseClients.size", () => {
    const sseClients = new Set<express.Response>();
    const wiring = wireGhQuota({ sseClients, store: makeStubStore(), resolveRepoFullName: () => null });
    try {
      expect(wiring.hasViewers()).toBe(false);
      sseClients.add({} as express.Response);
      expect(wiring.hasViewers()).toBe(true);
    } finally {
      wiring.stop();
    }
  });

  it("msSinceLastViewer returns 0 while at least one viewer is connected", () => {
    const sseClients = new Set<express.Response>();
    const fakeClient = {} as express.Response;
    sseClients.add(fakeClient);
    const wiring = wireGhQuota({ sseClients, store: makeStubStore(), resolveRepoFullName: () => null });
    try {
      wiring.onViewerAttached();
      expect(wiring.msSinceLastViewer()).toBe(0);
    } finally {
      wiring.stop();
    }
  });

  it("msSinceLastViewer returns Infinity before any viewer has ever attached", () => {
    const sseClients = new Set<express.Response>();
    const wiring = wireGhQuota({ sseClients, store: makeStubStore(), resolveRepoFullName: () => null });
    try {
      expect(wiring.msSinceLastViewer()).toBe(Number.POSITIVE_INFINITY);
    } finally {
      wiring.stop();
    }
  });

  it("onViewerDetached stamps lastDetachAt only when the LAST viewer leaves", () => {
    const sseClients = new Set<express.Response>();
    const a = {} as express.Response;
    const b = {} as express.Response;
    sseClients.add(a);
    sseClients.add(b);
    const wiring = wireGhQuota({ sseClients, store: makeStubStore(), resolveRepoFullName: () => null });
    try {
      wiring.onViewerAttached(); // first attach (a was added before; b added)
      wiring.onViewerAttached();
      expect(wiring.msSinceLastViewer()).toBe(0);
      sseClients.delete(a);
      wiring.onViewerDetached(); // b still connected
      expect(wiring.msSinceLastViewer()).toBe(0);
      sseClients.delete(b);
      wiring.onViewerDetached(); // now genuinely empty
      // Time may have moved a few ms; just assert it's now finite and >=0.
      const ms = wiring.msSinceLastViewer();
      expect(ms).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(ms)).toBe(true);
    } finally {
      wiring.stop();
    }
  });

  it("onViewerAttached fires scheduler.invalidateNotDue only on 0→1 transition", () => {
    const sseClients = new Set<express.Response>();
    const wiring = wireGhQuota({ sseClients, store: makeStubStore(), resolveRepoFullName: () => null });
    const invalidateSpy = vi.spyOn(wiring.scheduler, "invalidateNotDue");
    try {
      // First attach
      sseClients.add({} as express.Response);
      wiring.onViewerAttached();
      expect(invalidateSpy).toHaveBeenCalledTimes(1);
      // Second concurrent attach — should NOT re-invalidate
      sseClients.add({} as express.Response);
      wiring.onViewerAttached();
      expect(invalidateSpy).toHaveBeenCalledTimes(1);
      // Both detach → idle
      sseClients.clear();
      wiring.onViewerDetached();
      // Re-attach after idle — counts as a fresh 0→1 transition
      sseClients.add({} as express.Response);
      wiring.onViewerAttached();
      expect(invalidateSpy).toHaveBeenCalledTimes(2);
    } finally {
      wiring.stop();
    }
  });

  it("CITADEL_GH_SCHEDULER_DISABLED=1 returns a passthrough scheduler (shouldRefetch always true)", () => {
    const prev = process.env.CITADEL_GH_SCHEDULER_DISABLED;
    process.env.CITADEL_GH_SCHEDULER_DISABLED = "1";
    try {
      const sseClients = new Set<express.Response>();
      const wiring = wireGhQuota({ sseClients, store: makeStubStore(), resolveRepoFullName: () => null });
      try {
        expect(wiring.scheduler.shouldRefetch("owner/repo#1" as never)).toEqual({ fetch: true });
        // record/evict/markRepoMainMoved should be silent no-ops.
        wiring.scheduler.recordFetch("owner/repo#1" as never, {} as never, "ws_a");
        wiring.scheduler.markRepoMainMoved("owner/repo");
        wiring.scheduler.evict("ws_a");
        expect(wiring.scheduler._entries().size).toBe(0);
      } finally {
        wiring.stop();
      }
    } finally {
      if (prev === undefined) {
        delete process.env.CITADEL_GH_SCHEDULER_DISABLED;
      } else {
        process.env.CITADEL_GH_SCHEDULER_DISABLED = prev;
      }
    }
  });
});
