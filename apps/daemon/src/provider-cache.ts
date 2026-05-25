// Persistent provider cache. Writes through to <dataDir>/provider-cache.json
// so the cockpit can render PR/CI/Jira/usage pills immediately on first load
// after a daemon restart, instead of the prior 2–5s blank window.
//
// Race correctness for the bust/refresh path uses a per-key in-flight Symbol
// token (see app-helpers.ts:cachedProviderWithStaleFallback). The cache only
// owns the token map and the invariant that any mutator (set/delete/clear)
// invalidates the relevant key's token.
//
// The persistence layer is intentionally small: subclass Map so every existing
// call site picks up the flush hook without refactoring, debounce writes so
// we coalesce bursts, and write atomically (tmp + rename + 0o600) so a kill
// signal mid-write can't leave a half-written file.

import fs from "node:fs";
import path from "node:path";
import type { Workspace } from "@citadel/contracts";

const CACHE_FILE_NAME = "provider-cache.json";
const SCHEMA_VERSION = 1;
const MAX_ENTRIES = 5000;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const LOAD_TIMEOUT_MS = 500;
const FLUSH_DEBOUNCE_MS = 500;
const DEFAULT_FILE_MODE = 0o600;

export type ProviderCacheEntry = {
  expiresAt: number;
  value: unknown;
  cachedAt: number;
};

type PersistedShape = {
  version: number;
  savedAt: string;
  entries: Array<[string, ProviderCacheEntry]>;
};

export type ListWorkspacesFn = () => Workspace[];

export type CreateProviderCacheInput = {
  dataDir: string;
  mode?: number;
  listWorkspaces: ListWorkspacesFn;
};

export class PersistentProviderCache extends Map<string, ProviderCacheEntry> {
  // Public so app-helpers.ts can mint and check tokens from outside.
  readonly inFlightTokens = new Map<string, symbol>();
  loading = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushChain: Promise<void> = Promise.resolve();
  private readonly filePath: string;
  private readonly tmpPath: string;
  private readonly mode: number;
  private readonly listWorkspaces: ListWorkspacesFn;

  constructor(input: CreateProviderCacheInput) {
    super();
    this.filePath = path.join(input.dataDir, CACHE_FILE_NAME);
    this.tmpPath = `${this.filePath}.${process.pid}.tmp`;
    this.mode = input.mode ?? DEFAULT_FILE_MODE;
    this.listWorkspaces = input.listWorkspaces;
  }

  override set(key: string, value: ProviderCacheEntry): this {
    super.set(key, value);
    this.inFlightTokens.delete(key);
    this.scheduleFlush();
    return this;
  }

  override delete(key: string): boolean {
    const removed = super.delete(key);
    this.inFlightTokens.delete(key);
    if (removed) this.scheduleFlush();
    return removed;
  }

  override clear(): void {
    super.clear();
    this.inFlightTokens.clear();
    this.scheduleFlush();
  }

  async load(): Promise<void> {
    this.loading = true;
    let timedOut = false;
    let timedOutTimer: ReturnType<typeof setTimeout> | null = null;
    const readPromise = this.readAndParse();
    try {
      await Promise.race([
        readPromise,
        new Promise<void>((resolve) => {
          timedOutTimer = setTimeout(() => {
            timedOut = true;
            // Clearing loading here lets post-timeout live writes flush normally
            // even though the late read may still be pending.
            this.loading = false;
            resolve();
          }, LOAD_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timedOutTimer) clearTimeout(timedOutTimer);
    }
    // Late-resolution handler — only applies entries if we weren't already
    // forced to proceed with an empty cache. Without this guard the late read
    // would clobber any values the live system has already written.
    readPromise
      .then((entries) => {
        if (timedOut) return;
        this.applyEntries(entries);
        this.loading = false;
      })
      .catch((error) => {
        if (!timedOut) {
          console.error(`[provider-cache] load failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        this.loading = false;
      });
    // If the read won the race (timedOut === false), the applyEntries handler
    // above ran synchronously after the await. Wait one microtask so callers
    // observe the populated map.
    if (!timedOut) await readPromise.then(() => undefined).catch(() => undefined);
  }

  private async readAndParse(): Promise<Array<[string, ProviderCacheEntry]>> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    let parsed: PersistedShape;
    try {
      parsed = JSON.parse(raw) as PersistedShape;
    } catch (error) {
      console.error(
        `[provider-cache] could not parse ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
    if (parsed.version !== SCHEMA_VERSION) return [];
    if (!Array.isArray(parsed.entries)) return [];
    return parsed.entries.filter(
      (item): item is [string, ProviderCacheEntry] =>
        Array.isArray(item) &&
        item.length === 2 &&
        typeof item[0] === "string" &&
        item[1] != null &&
        typeof (item[1] as ProviderCacheEntry).cachedAt === "number",
    );
  }

  private applyEntries(entries: Array<[string, ProviderCacheEntry]>): void {
    const workspaces = new Set(this.listWorkspaces().map((w) => w.id));
    const now = Date.now();
    const fresh = entries.filter(([key, entry]) => {
      if (now - entry.cachedAt > MAX_AGE_MS) return false;
      const workspaceId = extractWorkspaceId(key);
      if (workspaceId !== null && !workspaces.has(workspaceId)) return false;
      return true;
    });
    // Most-recently-cached wins on truncation.
    fresh.sort((a, b) => b[1].cachedAt - a[1].cachedAt);
    const kept = fresh.slice(0, MAX_ENTRIES);
    for (const [key, entry] of kept) {
      // super.set bypasses our flush-scheduling subclass logic — we don't
      // want to write the file we just read.
      super.set(key, entry);
    }
  }

  private scheduleFlush(): void {
    if (this.loading) return;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushNow();
    }, FLUSH_DEBOUNCE_MS);
  }

  /**
   * Forces a synchronous flush (used by tests and dispose()). The flush chain
   * serializes concurrent writes so tests can await deterministically.
   */
  async flushImmediate(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushNow();
    await this.flushChain;
  }

  private flushNow(): void {
    const snapshot: PersistedShape = {
      version: SCHEMA_VERSION,
      savedAt: new Date().toISOString(),
      entries: Array.from(this.entries()),
    };
    const payload = JSON.stringify(snapshot);
    const next = this.flushChain.then(async () => {
      await fs.promises.writeFile(this.tmpPath, payload, { mode: this.mode });
      await fs.promises.rename(this.tmpPath, this.filePath);
      // rename preserves the source's mode on most filesystems, but chmod
      // defensively in case the destination existed with broader permissions.
      await fs.promises.chmod(this.filePath, this.mode);
    });
    this.flushChain = next.catch((error) => {
      console.error(`[provider-cache] flush failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  async dispose(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushNow();
    await this.flushChain;
  }
}

// Workspace-id cache keys all encode the workspace id as the second
// colon-separated segment: vc:<id>:<updatedAt>, ci:<id>:<updatedAt>,
// git:<id>:<updatedAt>, apps:<id>:<updatedAt>. Other keys (issue:<jiraKey>,
// usage:<runtimeId>:..., provider-health) return null so they bypass the
// orphan prune.
function extractWorkspaceId(key: string): string | null {
  const colon = key.indexOf(":");
  if (colon < 0) return null;
  const prefix = key.slice(0, colon);
  if (prefix !== "vc" && prefix !== "ci" && prefix !== "git" && prefix !== "apps") return null;
  const rest = key.slice(colon + 1);
  const next = rest.indexOf(":");
  return next < 0 ? rest : rest.slice(0, next);
}

export function createProviderCache(input: CreateProviderCacheInput): PersistentProviderCache {
  return new PersistentProviderCache(input);
}
