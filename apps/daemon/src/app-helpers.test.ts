import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cachedProviderWithStaleFallback } from "./app-helpers.js";
import { createProviderCache } from "./provider-cache.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-swr-"));
  dirs.push(dir);
  return dir;
}

async function flush() {
  // Drain microtasks + any setTimeout(0) deferred work.
  await new Promise((r) => setTimeout(r, 0));
}

describe("cachedProviderWithStaleFallback", () => {
  it("hit-fresh returns cached without calling load", async () => {
    const cache = createProviderCache({ dataDir: tempDataDir(), listWorkspaces: () => [] });
    await cache.load();
    cache.set("key", { expiresAt: Date.now() + 10_000, value: "cached", cachedAt: Date.now() });
    const load = vi.fn(async () => "fresh");
    const value = await cachedProviderWithStaleFallback({ cache, key: "key", load, ttlMs: 10_000 });
    expect(value).toBe("cached");
    expect(load).not.toHaveBeenCalled();
  });

  it("hit-stale returns cached and triggers background load", async () => {
    const cache = createProviderCache({ dataDir: tempDataDir(), listWorkspaces: () => [] });
    await cache.load();
    cache.set("key", { expiresAt: Date.now() - 1, value: "stale", cachedAt: Date.now() - 60_000 });
    const load = vi.fn(async () => "fresh");
    const value = await cachedProviderWithStaleFallback({ cache, key: "key", load, ttlMs: 10_000 });
    expect(value).toBe("stale");
    await flush();
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    expect(cache.get("key")?.value).toBe("fresh");
  });

  it("miss awaits load synchronously", async () => {
    const cache = createProviderCache({ dataDir: tempDataDir(), listWorkspaces: () => [] });
    await cache.load();
    const load = vi.fn(async () => "fresh");
    const value = await cachedProviderWithStaleFallback({ cache, key: "key", load, ttlMs: 10_000 });
    expect(value).toBe("fresh");
    expect(cache.get("key")?.value).toBe("fresh");
  });

  it("single-in-flight dedup: concurrent stale hits share one load call", async () => {
    const cache = createProviderCache({ dataDir: tempDataDir(), listWorkspaces: () => [] });
    await cache.load();
    cache.set("key", { expiresAt: Date.now() - 1, value: "stale", cachedAt: Date.now() - 60_000 });
    type Resolver = (v: string) => void;
    let resolveLoad: Resolver | null = null;
    const load = vi.fn(
      (): Promise<string> =>
        new Promise<string>((resolve) => {
          resolveLoad = resolve as Resolver;
        }),
    );
    await cachedProviderWithStaleFallback({ cache, key: "key", load, ttlMs: 10_000 });
    await cachedProviderWithStaleFallback({ cache, key: "key", load, ttlMs: 10_000 });
    await cachedProviderWithStaleFallback({ cache, key: "key", load, ttlMs: 10_000 });
    expect(load).toHaveBeenCalledTimes(1);
    (resolveLoad as Resolver | null)?.("fresh");
    await flush();
    await flush();
    expect(cache.get("key")?.value).toBe("fresh");
  });

  it("background error clears in-flight slot without busting cache", async () => {
    const cache = createProviderCache({ dataDir: tempDataDir(), listWorkspaces: () => [] });
    await cache.load();
    cache.set("key", { expiresAt: Date.now() - 1, value: "stale", cachedAt: Date.now() - 60_000 });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const load = vi
      .fn((): Promise<string> => Promise.resolve("unused"))
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce("fresh");
    await cachedProviderWithStaleFallback({ cache, key: "key", load, ttlMs: 10_000 });
    await flush();
    await flush();
    // Stale value survived the failure.
    expect(cache.get("key")?.value).toBe("stale");
    // A subsequent stale read can retry the load (in-flight slot was cleared).
    await cachedProviderWithStaleFallback({ cache, key: "key", load, ttlMs: 10_000 });
    await flush();
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    expect(cache.get("key")?.value).toBe("fresh");
    errSpy.mockRestore();
  });

  it("token check — bust on SAME key during in-flight discards stale write", async () => {
    const cache = createProviderCache({ dataDir: tempDataDir(), listWorkspaces: () => [] });
    await cache.load();
    cache.set("key", { expiresAt: Date.now() - 1, value: "stale", cachedAt: Date.now() - 60_000 });
    type Resolver = (v: string) => void;
    let resolveLoad: Resolver | null = null;
    const load = vi.fn(
      (): Promise<string> =>
        new Promise<string>((resolve) => {
          resolveLoad = resolve as Resolver;
        }),
    );
    await cachedProviderWithStaleFallback({ cache, key: "key", load, ttlMs: 10_000 });
    // Bust happens while the load is in flight — token is invalidated.
    cache.delete("key");
    (resolveLoad as Resolver | null)?.("from-load");
    await flush();
    await flush();
    // The stale load result must NOT have been written.
    expect(cache.has("key")).toBe(false);
  });

  it("token check — bust on a DIFFERENT key does NOT discard the write", async () => {
    const cache = createProviderCache({ dataDir: tempDataDir(), listWorkspaces: () => [] });
    await cache.load();
    cache.set("key", { expiresAt: Date.now() - 1, value: "stale", cachedAt: Date.now() - 60_000 });
    cache.set("other", { expiresAt: Date.now() + 10_000, value: "other-value", cachedAt: Date.now() });
    type Resolver = (v: string) => void;
    let resolveLoad: Resolver | null = null;
    const load = vi.fn(
      (): Promise<string> =>
        new Promise<string>((resolve) => {
          resolveLoad = resolve as Resolver;
        }),
    );
    await cachedProviderWithStaleFallback({ cache, key: "key", load, ttlMs: 10_000 });
    // Unrelated mutation on a different key MUST NOT invalidate the token for "key".
    cache.delete("other");
    (resolveLoad as Resolver | null)?.("from-load");
    await flush();
    await flush();
    expect(cache.get("key")?.value).toBe("from-load");
  });
});
