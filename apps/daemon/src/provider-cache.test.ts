import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Workspace } from "@citadel/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type PersistentProviderCache,
  type ProviderCacheEntry,
  createProviderCache,
  resolveUsageRefreshInterval,
} from "./provider-cache.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

function tempDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-provider-cache-"));
  dirs.push(dir);
  return dir;
}

function makeWorkspace(id: string): Workspace {
  return {
    id,
    repoId: "repo",
    name: id,
    path: `/tmp/${id}`,
    branch: "main",
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
    archivedAt: null,
    createdAt: "2026-05-25T00:00:00Z",
    updatedAt: "2026-05-25T00:00:00Z",
  } satisfies Workspace;
}

async function readJson(filePath: string): Promise<{ version: number; entries: Array<[string, ProviderCacheEntry]> }> {
  const raw = await fs.promises.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function waitForFlush(cache: PersistentProviderCache) {
  await cache.flushImmediate();
}

describe("createProviderCache.load()", () => {
  it("returns an empty cache when the file is absent", async () => {
    const dataDir = tempDataDir();
    const cache = createProviderCache({ dataDir, listLiveIds: () => [] });
    await cache.load();
    expect(cache.size).toBe(0);
  });

  it("drops entries older than 24h", async () => {
    const dataDir = tempDataDir();
    const filePath = path.join(dataDir, "provider-cache.json");
    const twentyFiveHoursAgo = Date.now() - 25 * 60 * 60 * 1000;
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        savedAt: new Date().toISOString(),
        entries: [
          ["vc:w1:t", { expiresAt: Date.now() + 1000, value: { fresh: true }, cachedAt: Date.now() }],
          ["vc:w2:t", { expiresAt: Date.now() + 1000, value: { stale: true }, cachedAt: twentyFiveHoursAgo }],
        ],
      }),
    );
    const cache = createProviderCache({ dataDir, listLiveIds: () => ["w1", "w2"] });
    await cache.load();
    expect(cache.has("vc:w1:t")).toBe(true);
    expect(cache.has("vc:w2:t")).toBe(false);
  });

  it("drops everything on schema-version mismatch", async () => {
    const dataDir = tempDataDir();
    const filePath = path.join(dataDir, "provider-cache.json");
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 99,
        savedAt: new Date().toISOString(),
        entries: [["vc:w1:t", { expiresAt: Date.now() + 1000, value: 1, cachedAt: Date.now() }]],
      }),
    );
    const cache = createProviderCache({ dataDir, listLiveIds: () => ["w1"] });
    await cache.load();
    expect(cache.size).toBe(0);
  });

  it("prunes entries whose key references an unknown workspace id", async () => {
    const dataDir = tempDataDir();
    const filePath = path.join(dataDir, "provider-cache.json");
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        savedAt: new Date().toISOString(),
        entries: [
          ["vc:w1:t", { expiresAt: Date.now() + 1000, value: "keep", cachedAt: Date.now() }],
          ["ci:ghost:t", { expiresAt: Date.now() + 1000, value: "drop", cachedAt: Date.now() }],
          ["issue:JIRA-1", { expiresAt: Date.now() + 1000, value: "non-ws-keep", cachedAt: Date.now() }],
        ],
      }),
    );
    const cache = createProviderCache({ dataDir, listLiveIds: () => ["w1"] });
    await cache.load();
    expect(cache.has("vc:w1:t")).toBe(true);
    expect(cache.has("ci:ghost:t")).toBe(false);
    // issue:* keys do not encode a workspace id; they survive the prune.
    expect(cache.has("issue:JIRA-1")).toBe(true);
  });

  it("truncates to 5000 entries (most-recently-cached wins)", async () => {
    const dataDir = tempDataDir();
    const filePath = path.join(dataDir, "provider-cache.json");
    const ws = makeWorkspace("w1");
    const now = Date.now();
    const entries: Array<[string, ProviderCacheEntry]> = [];
    for (let i = 0; i < 5050; i++) {
      entries.push([`vc:w1:${i}`, { expiresAt: now + 1000, value: i, cachedAt: now - (5050 - i) * 1000 }]);
    }
    fs.writeFileSync(filePath, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), entries }));
    const cache = createProviderCache({ dataDir, listLiveIds: () => [ws.id] });
    await cache.load();
    expect(cache.size).toBe(5000);
    // Most-recently-cached survives — entries with higher i had a more recent cachedAt.
    expect(cache.has("vc:w1:5049")).toBe(true);
    expect(cache.has("vc:w1:0")).toBe(false);
  });

  it("returns empty when load takes longer than 500ms (timeout)", async () => {
    const dataDir = tempDataDir();
    // Write a sentinel that the test reader will block on by mocking fs.promises.readFile.
    const readFileSpy = vi.spyOn(fs.promises, "readFile").mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 1_000));
      return JSON.stringify({ version: 1, savedAt: "", entries: [] });
    });
    const cache = createProviderCache({ dataDir, listLiveIds: () => [] });
    const start = Date.now();
    await cache.load();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(900);
    expect(cache.size).toBe(0);
    readFileSpy.mockRestore();
  });

  it("late-resolving read after timeout does NOT mutate cache populated since startup", async () => {
    const dataDir = tempDataDir();
    const filePath = path.join(dataDir, "provider-cache.json");
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        savedAt: new Date().toISOString(),
        entries: [["vc:w1:t", { expiresAt: Date.now() + 1000, value: "from-disk", cachedAt: Date.now() }]],
      }),
    );
    const realRead = fs.promises.readFile;
    const readSpy = vi.spyOn(fs.promises, "readFile").mockImplementation(async (filename, options) => {
      await new Promise((r) => setTimeout(r, 800));
      return realRead.call(fs.promises, filename, options);
    });
    const cache = createProviderCache({ dataDir, listLiveIds: () => ["w1"] });
    await cache.load();
    // Live system writes a fresh value after the 500ms timeout fired but before
    // the late read resolves at ~800ms.
    cache.set("vc:w1:t", { expiresAt: Date.now() + 1000, value: "from-live", cachedAt: Date.now() });
    await new Promise((r) => setTimeout(r, 500));
    expect(cache.get("vc:w1:t")?.value).toBe("from-live");
    readSpy.mockRestore();
    // Dispose to drain any pending flush BEFORE afterEach rms the dataDir.
    // Without this the debounced write races the cleanup and can ENOTEMPTY.
    await cache.dispose();
  });

  it("logs and continues on parse error", async () => {
    const dataDir = tempDataDir();
    fs.writeFileSync(path.join(dataDir, "provider-cache.json"), "{not json");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const cache = createProviderCache({ dataDir, listLiveIds: () => [] });
    await expect(cache.load()).resolves.toBeUndefined();
    expect(cache.size).toBe(0);
    errSpy.mockRestore();
  });
});

describe("PersistentProviderCache mutators", () => {
  it("set() invalidates the per-key in-flight token AND schedules a debounced flush", async () => {
    const dataDir = tempDataDir();
    const cache = createProviderCache({ dataDir, listLiveIds: () => ["w1"] });
    await cache.load();
    const token = Symbol("test");
    cache.inFlightTokens.set("vc:w1:t", token);
    cache.set("vc:w1:t", { expiresAt: Date.now() + 1000, value: 1, cachedAt: Date.now() });
    expect(cache.inFlightTokens.has("vc:w1:t")).toBe(false);
    await waitForFlush(cache);
    const onDisk = await readJson(path.join(dataDir, "provider-cache.json"));
    expect(onDisk.entries.some(([k]) => k === "vc:w1:t")).toBe(true);
  });

  it("delete() invalidates the per-key in-flight token AND schedules a flush", async () => {
    const dataDir = tempDataDir();
    const cache = createProviderCache({ dataDir, listLiveIds: () => ["w1"] });
    await cache.load();
    cache.set("vc:w1:t", { expiresAt: Date.now() + 1000, value: 1, cachedAt: Date.now() });
    await waitForFlush(cache);
    const token = Symbol("test");
    cache.inFlightTokens.set("vc:w1:t", token);
    cache.delete("vc:w1:t");
    expect(cache.inFlightTokens.has("vc:w1:t")).toBe(false);
    await waitForFlush(cache);
    const onDisk = await readJson(path.join(dataDir, "provider-cache.json"));
    expect(onDisk.entries.some(([k]) => k === "vc:w1:t")).toBe(false);
  });

  it("clear() empties all tokens AND schedules a flush", async () => {
    const dataDir = tempDataDir();
    const cache = createProviderCache({ dataDir, listLiveIds: () => ["w1"] });
    await cache.load();
    cache.set("vc:w1:t", { expiresAt: Date.now() + 1000, value: 1, cachedAt: Date.now() });
    cache.inFlightTokens.set("vc:w1:t", Symbol());
    cache.inFlightTokens.set("ci:w1:t", Symbol());
    cache.clear();
    expect(cache.inFlightTokens.size).toBe(0);
    await waitForFlush(cache);
    const onDisk = await readJson(path.join(dataDir, "provider-cache.json"));
    expect(onDisk.entries.length).toBe(0);
  });

  it("set() during load() (loading=true) does NOT schedule a flush", async () => {
    const dataDir = tempDataDir();
    const filePath = path.join(dataDir, "provider-cache.json");
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        savedAt: new Date().toISOString(),
        entries: [["vc:w1:t", { expiresAt: Date.now() + 1000, value: "from-disk", cachedAt: Date.now() }]],
      }),
    );
    const cache = createProviderCache({ dataDir, listLiveIds: () => ["w1"] });
    // Capture current file mtime; after load() finishes the in-memory set
    // calls from hydrate must NOT have rewritten the file.
    const beforeMtime = fs.statSync(filePath).mtimeMs;
    await cache.load();
    expect(cache.has("vc:w1:t")).toBe(true);
    // Allow flush debounce to elapse if any leaked.
    await new Promise((r) => setTimeout(r, 700));
    const afterMtime = fs.statSync(filePath).mtimeMs;
    expect(afterMtime).toBe(beforeMtime);
  });

  it("set() AFTER the 500ms timeout (loading=false) DOES schedule a flush even if the late read hasn't resolved", async () => {
    const dataDir = tempDataDir();
    const filePath = path.join(dataDir, "provider-cache.json");
    fs.writeFileSync(filePath, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), entries: [] }));
    const realRead = fs.promises.readFile;
    const readSpy = vi.spyOn(fs.promises, "readFile").mockImplementation(async (filename, options) => {
      await new Promise((r) => setTimeout(r, 1500));
      return realRead.call(fs.promises, filename, options);
    });
    const cache = createProviderCache({ dataDir, listLiveIds: () => ["w1"] });
    await cache.load(); // returns after 500ms timeout; late read still pending
    // Live system writes — loading must be false now, so this should schedule a flush.
    cache.set("vc:w1:t", { expiresAt: Date.now() + 1000, value: "live", cachedAt: Date.now() });
    await waitForFlush(cache);
    const onDisk = await readJson(filePath);
    expect(onDisk.entries.some(([k]) => k === "vc:w1:t")).toBe(true);
    readSpy.mockRestore();
  });
});

describe("PersistentProviderCache.flush()", () => {
  it("writes atomically (tmp + rename) with mode 0o600", async () => {
    const dataDir = tempDataDir();
    const filePath = path.join(dataDir, "provider-cache.json");
    const cache = createProviderCache({ dataDir, listLiveIds: () => ["w1"] });
    await cache.load();
    // Spy on rename + writeFile so we can prove tmp-then-rename, not direct-write.
    const writeFileSpy = vi.spyOn(fs.promises, "writeFile");
    const renameSpy = vi.spyOn(fs.promises, "rename");
    cache.set("vc:w1:t", { expiresAt: Date.now() + 1000, value: 1, cachedAt: Date.now() });
    await waitForFlush(cache);
    expect(fs.existsSync(filePath)).toBe(true);
    const stat = fs.statSync(filePath);
    expect(stat.mode & 0o777).toBe(0o600);
    // No leftover tmp files in the dataDir.
    const tmpLeftover = fs.readdirSync(dataDir).filter((f) => f.includes(".tmp"));
    expect(tmpLeftover.length).toBe(0);
    // Atomic-write verification: writeFile target was the .tmp path, NOT the
    // final path. rename then promoted .tmp → final. A regression to direct-
    // writeFile-of-final-path would be caught here.
    expect(writeFileSpy).toHaveBeenCalled();
    const writeTarget = writeFileSpy.mock.calls[0]?.[0];
    expect(typeof writeTarget === "string" && writeTarget.includes(".tmp")).toBe(true);
    expect(renameSpy).toHaveBeenCalled();
    const renameArgs = renameSpy.mock.calls[0];
    expect(typeof renameArgs?.[0] === "string" && renameArgs[0].includes(".tmp")).toBe(true);
    expect(renameArgs?.[1]).toBe(filePath);
    writeFileSpy.mockRestore();
    renameSpy.mockRestore();
  });
});

describe("resolveUsageRefreshInterval", () => {
  const config = {
    providerRefresh: { intervals: { usageMs: 5 * 60_000 } },
  } as Parameters<typeof resolveUsageRefreshInterval>[1];

  it("returns the provider override when set", () => {
    expect(resolveUsageRefreshInterval({ refreshIntervalMs: 30_000 }, config)).toBe(30_000);
  });

  it("falls back to the daemon-wide default when provider is undefined", () => {
    expect(resolveUsageRefreshInterval(undefined, config)).toBe(5 * 60_000);
  });

  it("falls back when provider has no refreshIntervalMs", () => {
    expect(resolveUsageRefreshInterval({}, config)).toBe(5 * 60_000);
  });
});

describe("PersistentProviderCache.dispose()", () => {
  it("does not write an empty cache on clean shutdown", async () => {
    const dataDir = tempDataDir();
    const filePath = path.join(dataDir, "provider-cache.json");
    const cache = createProviderCache({ dataDir, listLiveIds: () => [] });
    await cache.load();

    await cache.dispose();

    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("flushes pending writes synchronously", async () => {
    const dataDir = tempDataDir();
    const filePath = path.join(dataDir, "provider-cache.json");
    const cache = createProviderCache({ dataDir, listLiveIds: () => ["w1"] });
    await cache.load();
    cache.set("vc:w1:t", { expiresAt: Date.now() + 1000, value: 1, cachedAt: Date.now() });
    // Do not wait for the debounce — dispose() must drain it.
    await cache.dispose();
    expect(fs.existsSync(filePath)).toBe(true);
    const onDisk = await readJson(filePath);
    expect(onDisk.entries.some(([k]) => k === "vc:w1:t")).toBe(true);
  });
});
