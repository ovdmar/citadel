import { describe, expect, it } from "vitest";
import { createSaveCoordinator, formatBytes, pillLabel, pillSlug } from "./scratchpad-helpers.js";

describe("formatBytes", () => {
  it("renders bytes under 1 KB plainly", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("crosses to KB at 1024", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(1024 * 1024 - 1)).toMatch(/KB$/);
  });

  it("crosses to MB at 1 MiB", () => {
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("pillSlug", () => {
  it("maps known sources to slug classes", () => {
    expect(pillSlug("ui")).toBe("ui");
    expect(pillSlug("mcp:write_scratchpad")).toBe("mcp-write");
    expect(pillSlug("mcp:append_scratchpad")).toBe("mcp-append");
    expect(pillSlug("backfill")).toBe("backfill");
    expect(pillSlug("restore:scratch_123_abc")).toBe("restore");
  });

  it("passes unknown sources through unchanged", () => {
    expect(pillSlug("custom")).toBe("custom");
  });
});

describe("pillLabel", () => {
  it("renders friendly labels for each source", () => {
    expect(pillLabel("ui")).toBe("UI");
    expect(pillLabel("mcp:write_scratchpad")).toBe("MCP write");
    expect(pillLabel("mcp:append_scratchpad")).toBe("MCP append");
    expect(pillLabel("backfill")).toBe("Backfill");
    expect(pillLabel("restore:abc")).toBe("Restore");
    expect(pillLabel("custom")).toBe("custom");
  });
});

describe("createSaveCoordinator", () => {
  type Harness = {
    latest: string;
    lastSaved: string;
    putCalls: string[];
    loadCalls: number;
    putDeferred: { resolve: (value: { content: string }) => void; reject: (reason: unknown) => void } | null;
    coordinator: ReturnType<typeof createSaveCoordinator>;
  };

  function buildHarness(opts: { defer?: boolean } = {}): Harness {
    const h: Harness = {
      latest: "",
      lastSaved: "",
      putCalls: [],
      loadCalls: 0,
      putDeferred: null,
      coordinator: null as unknown as ReturnType<typeof createSaveCoordinator>,
    };
    h.coordinator = createSaveCoordinator({
      getLatest: () => h.latest,
      getLastSaved: () => h.lastSaved,
      setLastSaved: (value) => {
        h.lastSaved = value;
      },
      put: (snapshot) => {
        h.putCalls.push(snapshot);
        if (opts.defer) {
          return new Promise<{ content: string }>((resolve, reject) => {
            h.putDeferred = { resolve, reject };
          });
        }
        return Promise.resolve({ content: snapshot });
      },
      load: () => {
        h.loadCalls += 1;
        return Promise.resolve();
      },
    });
    return h;
  }

  it("no-ops save when latest equals lastSaved", async () => {
    const h = buildHarness();
    h.latest = "x";
    h.lastSaved = "x";
    await h.coordinator.save();
    expect(h.putCalls).toEqual([]);
  });

  it("PUTs once when latest differs from lastSaved", async () => {
    const h = buildHarness();
    h.latest = "x";
    await h.coordinator.save();
    expect(h.putCalls).toEqual(["x"]);
    expect(h.lastSaved).toBe("x");
  });

  it("loops until latest stabilizes (typing during save)", async () => {
    const h = buildHarness({ defer: true });
    h.latest = "v1";
    const savePromise = h.coordinator.save();
    // First PUT in flight. Simulate typing while it's still pending.
    h.latest = "v2";
    h.putDeferred?.resolve({ content: "v1" });
    // Allow microtasks to run so the loop iterates.
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.putDeferred?.resolve({ content: "v2" });
    await savePromise;
    expect(h.putCalls).toEqual(["v1", "v2"]);
    expect(h.lastSaved).toBe("v2");
  });

  it("queues SSE refresh fired during a save and replays it after the loop", async () => {
    const h = buildHarness({ defer: true });
    h.latest = "typed";
    const savePromise = h.coordinator.save();
    // SSE arrives mid-save.
    expect(h.coordinator.noteSseRefresh()).toBe("queued");
    expect(h.coordinator.state.saving).toBe(true);
    expect(h.coordinator.state.pendingRefresh).toBe(true);
    expect(h.loadCalls).toBe(0);
    h.putDeferred?.resolve({ content: "typed" });
    await savePromise;
    expect(h.coordinator.state.saving).toBe(false);
    expect(h.coordinator.state.pendingRefresh).toBe(false);
    expect(h.loadCalls).toBe(1);
  });

  it("invokes load immediately when SSE fires while idle", () => {
    const h = buildHarness();
    expect(h.coordinator.noteSseRefresh()).toBe("immediate");
    expect(h.loadCalls).toBe(1);
    expect(h.coordinator.state.pendingRefresh).toBe(false);
  });

  it("collapses multiple SSE refreshes during a single save into one replay", async () => {
    const h = buildHarness({ defer: true });
    h.latest = "typed";
    const savePromise = h.coordinator.save();
    h.coordinator.noteSseRefresh();
    h.coordinator.noteSseRefresh();
    h.coordinator.noteSseRefresh();
    h.putDeferred?.resolve({ content: "typed" });
    await savePromise;
    expect(h.loadCalls).toBe(1);
  });

  it("clears the saving flag and replays pending refresh even when put rejects", async () => {
    const h = buildHarness({ defer: true });
    h.latest = "typed";
    const savePromise = h.coordinator.save();
    h.coordinator.noteSseRefresh();
    h.putDeferred?.reject(new Error("boom"));
    await expect(savePromise).rejects.toThrow("boom");
    expect(h.coordinator.state.saving).toBe(false);
    expect(h.loadCalls).toBe(1);
  });
});
