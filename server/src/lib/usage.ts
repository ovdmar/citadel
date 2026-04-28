import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { USAGE_HISTORY_PATH } from './config.js';
import { ensureParent, readJsonFile } from './fs.js';
import fs from 'node:fs';

const execFileAsync = promisify(execFile);
const CACHE_TTL_MS = 30 * 60_000;
const CLAUDE_RATE_LIMIT_BACKOFF_MS = 60 * 60_000;
const HISTORY_LIMIT = 500;
const PROVIDERS = ['claude', 'codex'] as const;

export type UsageProviderId = typeof PROVIDERS[number];

type UsageWindow = {
  usedPercent?: number;
  remainingPercent?: number;
  resetsAt?: string;
  resetDescription?: string;
  windowMinutes?: number;
  lastsUntilReset?: boolean;
  paceStatus?: 'lasts' | 'wont_last';
  paceSource?: 'provider' | 'computed';
  reservePercent?: number;
  expectedUsedPercent?: number;
};

export type UsageProviderSnapshot = {
  provider: UsageProviderId;
  available: boolean;
  status: 'ready' | 'pending' | 'error';
  stale: boolean;
  refreshing: boolean;
  fetchedAt?: string;
  source?: string;
  version?: string;
  error?: string;
  primary?: UsageWindow;
  secondary?: UsageWindow;
  tertiary?: UsageWindow;
  loginMethod?: string;
  accountEmail?: string;
  providerID?: string;
  raw?: unknown;
};

export type UsageSnapshot = {
  generatedAt: string;
  cacheTtlMs: number;
  refreshing: boolean;
  hasAnyData: boolean;
  providers: Record<UsageProviderId, UsageProviderSnapshot>;
};

export type UsageHistoryPoint = {
  provider: UsageProviderId;
  fetchedAt: string;
  weeklyRemainingPercent?: number;
  weeklyUsedPercent?: number;
  shortRemainingPercent?: number;
  shortUsedPercent?: number;
  lastsUntilReset?: boolean;
  paceStatus?: 'lasts' | 'wont_last';
  reservePercent?: number;
  expectedUsedPercent?: number;
};

type CacheEntry = {
  provider: UsageProviderId;
  data?: UsageProviderSnapshot;
  fetchedAtMs?: number;
  refreshing: boolean;
  inflight?: Promise<UsageProviderSnapshot>;
  backoffUntilMs?: number;
};

const cache = new Map<UsageProviderId, CacheEntry>(
  PROVIDERS.map((provider) => [provider, { provider, refreshing: false }])
);

function computeLastsUntilReset(window: UsageWindow | undefined) {
  if (!window?.resetsAt || typeof window.windowMinutes !== 'number' || typeof window.remainingPercent !== 'number') return undefined;
  const resetAtMs = new Date(window.resetsAt).getTime();
  if (!Number.isFinite(resetAtMs)) return undefined;
  const windowMs = window.windowMinutes * 60_000;
  if (windowMs <= 0) return undefined;
  const startAtMs = resetAtMs - windowMs;
  const elapsedFraction = Math.max(0, Math.min(1, (Date.now() - startAtMs) / windowMs));
  const expectedRemainingPercent = (1 - elapsedFraction) * 100;
  return window.remainingPercent >= expectedRemainingPercent;
}

function loadUsageHistory(): UsageHistoryPoint[] {
  const value = readJsonFile<UsageHistoryPoint[]>(USAGE_HISTORY_PATH);
  return Array.isArray(value) ? value : [];
}

function saveUsageHistory(history: UsageHistoryPoint[]) {
  ensureParent(USAGE_HISTORY_PATH);
  fs.writeFileSync(USAGE_HISTORY_PATH, JSON.stringify(history.slice(-HISTORY_LIMIT), null, 2));
}

function appendUsageHistory(data: UsageProviderSnapshot) {
  const history = loadUsageHistory();
  history.push({
    provider: data.provider,
    fetchedAt: data.fetchedAt || new Date().toISOString(),
    weeklyRemainingPercent: data.secondary?.remainingPercent,
    weeklyUsedPercent: data.secondary?.usedPercent,
    shortRemainingPercent: data.primary?.remainingPercent,
    shortUsedPercent: data.primary?.usedPercent,
    lastsUntilReset: data.secondary?.lastsUntilReset,
    paceStatus: data.secondary?.paceStatus,
    reservePercent: data.secondary?.reservePercent,
    expectedUsedPercent: data.secondary?.expectedUsedPercent,
  });
  saveUsageHistory(history);
}

function normalizeWindow(input: any): UsageWindow | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const usedPercent = typeof input.usedPercent === 'number' ? input.usedPercent : undefined;
  const window: UsageWindow = {
    usedPercent,
    remainingPercent: typeof usedPercent === 'number' ? Math.max(0, Math.min(100, 100 - usedPercent)) : undefined,
    resetsAt: typeof input.resetsAt === 'string' ? input.resetsAt : undefined,
    resetDescription: typeof input.resetDescription === 'string' ? input.resetDescription : undefined,
    windowMinutes: typeof input.windowMinutes === 'number' ? input.windowMinutes : undefined,
  };
  const computed = computeLastsUntilReset(window);
  if (computed !== undefined) {
    window.lastsUntilReset = computed;
    window.paceStatus = computed ? 'lasts' : 'wont_last';
    window.paceSource = 'computed';
  }
  return window;
}

type ParsedPace = {
  lastsUntilReset?: boolean;
  reservePercent?: number;
  expectedUsedPercent?: number;
};

function parsePaceFromPlainOutput(output: string): ParsedPace {
  const line = output
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => /^Pace:/i.test(item));
  if (!line) return {};

  const reserveMatch = line.match(/Pace:\s*([\d.]+)%\s+in reserve/i);
  const expectedMatch = line.match(/Expected\s+([\d.]+)%\s+used/i);
  const lasts = /lasts until reset/i.test(line) ? true : /won[’']?t last until reset|will not last until reset/i.test(line) ? false : undefined;

  return {
    lastsUntilReset: lasts,
    reservePercent: reserveMatch ? Number(reserveMatch[1]) : undefined,
    expectedUsedPercent: expectedMatch ? Number(expectedMatch[1]) : undefined,
  };
}

function applyPace(window: UsageWindow | undefined, pace: ParsedPace) {
  if (!window) return;
  if (pace.lastsUntilReset !== undefined) {
    window.lastsUntilReset = pace.lastsUntilReset;
    window.paceStatus = pace.lastsUntilReset ? 'lasts' : 'wont_last';
    window.paceSource = 'provider';
  }
  if (typeof pace.reservePercent === 'number') window.reservePercent = pace.reservePercent;
  if (typeof pace.expectedUsedPercent === 'number') window.expectedUsedPercent = pace.expectedUsedPercent;
}

function normalizeUsagePayload(provider: UsageProviderId, payload: any, pace?: ParsedPace): UsageProviderSnapshot {
  const usage = payload?.usage || {};
  const identity = usage?.identity || {};
  const primary = normalizeWindow(usage?.primary);
  const secondary = normalizeWindow(usage?.secondary);
  const tertiary = normalizeWindow(usage?.tertiary);
  applyPace(secondary, pace || {});
  return {
    provider,
    available: true,
    status: 'ready',
    stale: false,
    refreshing: false,
    fetchedAt: typeof usage?.updatedAt === 'string' ? usage.updatedAt : new Date().toISOString(),
    source: typeof payload?.source === 'string' ? payload.source : undefined,
    version: typeof payload?.version === 'string' ? payload.version : undefined,
    primary,
    secondary,
    tertiary,
    loginMethod: typeof usage?.loginMethod === 'string' ? usage.loginMethod : typeof identity?.loginMethod === 'string' ? identity.loginMethod : undefined,
    accountEmail: typeof usage?.accountEmail === 'string' ? usage.accountEmail : typeof identity?.accountEmail === 'string' ? identity.accountEmail : undefined,
    providerID: typeof identity?.providerID === 'string' ? identity.providerID : provider,
    raw: payload,
  };
}

async function fetchProviderUsage(provider: UsageProviderId): Promise<UsageProviderSnapshot> {
  const startedAt = Date.now();
  const [jsonResult, plainResult] = await Promise.all([
    execFileAsync('codexbar', ['usage', '--provider', provider, '--source', 'cli', '--json-only'], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 120_000,
    }),
    execFileAsync('codexbar', ['usage', '--provider', provider, '--source', 'cli'], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 120_000,
    }).catch(() => ({ stdout: '' })),
  ]);
  const parsed = JSON.parse(jsonResult.stdout);
  const payload = Array.isArray(parsed) ? parsed[0] : parsed;
  const pace = parsePaceFromPlainOutput(plainResult.stdout || '');
  const normalized = normalizeUsagePayload(provider, payload, pace);
  normalized.fetchedAt = normalized.fetchedAt || new Date(startedAt).toISOString();
  return normalized;
}


function isClaudeRateLimitedError(provider: UsageProviderId, message: string) {
  return provider === 'claude' && message.includes('Claude CLI usage endpoint is rate limited right now');
}

function buildBackoffErrorMessage(message: string, backoffUntilMs: number) {
  return `${message} Backing off until ${new Date(backoffUntilMs).toISOString()}.`;
}

function isEntryStale(entry: CacheEntry | undefined) {
  if (!entry?.data || !entry.fetchedAtMs) return true;
  return Date.now() - entry.fetchedAtMs > CACHE_TTL_MS;
}

function snapshotForEntry(provider: UsageProviderId, entry: CacheEntry | undefined): UsageProviderSnapshot {
  if (!entry?.data) {
    return {
      provider,
      available: false,
      status: entry?.refreshing ? 'pending' : 'pending',
      stale: true,
      refreshing: Boolean(entry?.refreshing),
    };
  }

  return {
    ...entry.data,
    stale: isEntryStale(entry),
    refreshing: Boolean(entry.refreshing),
    status: entry.data.status,
  };
}

async function refreshProvider(provider: UsageProviderId): Promise<UsageProviderSnapshot> {
  const entry = cache.get(provider)!;
  if (entry.inflight) return entry.inflight;
  if (entry.backoffUntilMs && Date.now() < entry.backoffUntilMs) {
    const message = buildBackoffErrorMessage(
      entry.data?.error || 'Claude CLI usage endpoint is rate limited right now',
      entry.backoffUntilMs
    );
    entry.data = entry.data
      ? { ...entry.data, stale: true, refreshing: false, status: 'error', error: message }
      : {
          provider,
          available: false,
          status: 'error',
          stale: true,
          refreshing: false,
          error: message,
        };
    return entry.data;
  }

  entry.refreshing = true;
  entry.inflight = fetchProviderUsage(provider)
    .then((data) => {
      entry.backoffUntilMs = undefined;
      entry.data = data;
      entry.fetchedAtMs = Date.now();
      appendUsageHistory(data);
      return data;
    })
    .catch((error) => {
      const rawMessage = error instanceof Error ? error.message : 'usage_refresh_failed';
      const backoffUntilMs = isClaudeRateLimitedError(provider, rawMessage) ? Date.now() + CLAUDE_RATE_LIMIT_BACKOFF_MS : undefined;
      if (backoffUntilMs) entry.backoffUntilMs = backoffUntilMs;
      const message = backoffUntilMs ? buildBackoffErrorMessage(rawMessage, backoffUntilMs) : rawMessage;
      entry.data = entry.data
        ? { ...entry.data, stale: true, refreshing: false, status: 'error', error: message }
        : {
            provider,
            available: false,
            status: 'error',
            stale: true,
            refreshing: false,
            error: message,
          };
      return entry.data;
    })
    .finally(() => {
      entry.refreshing = false;
      entry.inflight = undefined;
    });

  return entry.inflight;
}

export function primeUsageCacheInBackground(force = false) {
  for (const provider of PROVIDERS) {
    const entry = cache.get(provider)!;
    if (force || !entry.data || isEntryStale(entry)) {
      void refreshProvider(provider);
    }
  }
}

export async function forceRefreshUsageCache() {
  await Promise.all(PROVIDERS.map((provider) => refreshProvider(provider)));
  return getUsageSnapshot({ triggerBackgroundRefresh: false });
}

export function getUsageHistory() {
  return loadUsageHistory();
}

export function getUsageSnapshot(options?: { triggerBackgroundRefresh?: boolean }) : UsageSnapshot {
  const triggerBackgroundRefresh = options?.triggerBackgroundRefresh ?? true;

  if (triggerBackgroundRefresh) {
    for (const provider of PROVIDERS) {
      const entry = cache.get(provider)!;
      if (!entry.refreshing && (!entry.data || isEntryStale(entry))) {
        void refreshProvider(provider);
      }
    }
  }

  const providers = Object.fromEntries(
    PROVIDERS.map((provider) => {
      const entry = cache.get(provider);
      return [provider, snapshotForEntry(provider, entry)];
    })
  ) as Record<UsageProviderId, UsageProviderSnapshot>;

  return {
    generatedAt: new Date().toISOString(),
    cacheTtlMs: CACHE_TTL_MS,
    refreshing: PROVIDERS.some((provider) => Boolean(cache.get(provider)?.refreshing)),
    hasAnyData: PROVIDERS.some((provider) => Boolean(cache.get(provider)?.data)),
    providers,
  };
}
