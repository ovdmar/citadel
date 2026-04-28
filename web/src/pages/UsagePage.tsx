import { BarChart3, Clock3, RefreshCw, TrendingUp } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { AppCard, Button } from '../components/ui';
import { forceRefreshUsageSnapshot, formatFriendlyDateTime, loadUsageHistory, loadUsageSnapshot, relativeTime, usageWindowTone, usageWindowWillLastUntilReset } from '../lib';
import type { UsageHistoryPoint, UsageProviderSnapshot, UsageSnapshot, UsageWindow } from '../types';

function durationLabel(resetsAt?: string) {
  if (!resetsAt) return '—';
  const diffMs = new Date(resetsAt).getTime() - Date.now();
  if (diffMs <= 0) return 'now';
  const totalHours = Math.floor(diffMs / 3_600_000);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  if (days > 0) return `${days}d${hours > 0 ? `${hours}h` : ''}`;
  const minutes = Math.floor((diffMs % 3_600_000) / 60_000);
  return `${hours}h${minutes > 0 ? `${minutes}m` : ''}`;
}

function paceLabel(window?: UsageWindow) {
  const willLast = usageWindowWillLastUntilReset(window);
  if (willLast === undefined) return 'Pace unknown';
  return willLast ? 'Lasts until reset' : "Won’t last until reset";
}

function paceClass(window?: UsageWindow) {
  const tone = usageWindowTone(window);
  if (tone === 'ok') return 'usage-summary-good';
  if (tone === 'danger') return 'usage-summary-bad';
  return '';
}

function percentage(value?: number) {
  return typeof value === 'number' ? `${value}%` : '—';
}

function Meter({ label, window, emphasizePace = false }: { label: string; window?: UsageWindow; emphasizePace?: boolean }) {
  const remaining = window?.remainingPercent ?? 0;
  const tone = usageWindowTone(window);
  const meterClass = tone === 'ok' ? 'usage-meter-fill-good' : tone === 'danger' ? 'usage-meter-fill-bad' : 'usage-meter-fill-neutral';
  return (
    <div className="usage-meter-card">
      <div className="usage-meter-head">
        <div>
          <div className="section-title">{label}</div>
          <div className="usage-meter-value">{percentage(window?.remainingPercent)} left</div>
        </div>
        <div className="usage-meter-side">
          <span className="usage-reset-chip"><Clock3 size={13} /> {durationLabel(window?.resetsAt)}</span>
        </div>
      </div>
      <div className="usage-meter-track">
        <div className={`usage-meter-fill ${meterClass}`} style={{ width: `${Math.max(0, Math.min(100, remaining))}%` }} />
      </div>
      <div className="usage-meter-meta">
        <span>{percentage(window?.usedPercent)} used</span>
        {emphasizePace ? <span className={paceClass(window)}>{paceLabel(window)}</span> : <span>{window?.resetsAt ? formatFriendlyDateTime(window.resetsAt) : '—'}</span>}
      </div>
    </div>
  );
}

function Sparkline({ points }: { points: UsageHistoryPoint[] }) {
  const values = points.map((point) => point.weeklyRemainingPercent).filter((value): value is number => typeof value === 'number');
  if (!values.length) return <div className="muted">History will appear after a few cache refreshes.</div>;
  const width = 320;
  const height = 90;
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const polyline = values.map((value, index) => `${index * step},${height - (value / 100) * height}`).join(' ');
  return (
    <div className="usage-chart-wrap">
      <svg viewBox={`0 0 ${width} ${height}`} className="usage-chart" preserveAspectRatio="none" aria-hidden="true">
        <line x1="0" y1="0" x2={String(width)} y2="0" className="usage-chart-grid" />
        <line x1="0" y1={String(height / 2)} x2={String(width)} y2={String(height / 2)} className="usage-chart-grid" />
        <line x1="0" y1={String(height)} x2={String(width)} y2={String(height)} className="usage-chart-grid" />
        <polyline points={polyline} className="usage-chart-line" />
      </svg>
      <div className="usage-chart-footer">
        <span>{formatFriendlyDateTime(points[0]?.fetchedAt)}</span>
        <span>{formatFriendlyDateTime(points[points.length - 1]?.fetchedAt)}</span>
      </div>
    </div>
  );
}

function ProviderColumn({ label, provider, history }: { label: string; provider?: UsageProviderSnapshot; history: UsageHistoryPoint[] }) {
  const weekly = provider?.secondary;
  const short = provider?.primary;
  const extended = provider?.tertiary;
  const statusTone = weekly || short;

  return (
    <section className="usage-provider-column usage-provider-section">
      <AppCard className="usage-provider-hero-card">
        <div className="usage-provider-hero-top">
          <div>
            <div className="usage-provider-name">{label}</div>
            <div className={`usage-provider-opinion ${paceClass(weekly)}`}>{paceLabel(weekly)}</div>
          </div>
          <span className={`state-pill ${provider?.status === 'error' ? 'state-pill-failed' : provider?.refreshing ? 'state-pill-running' : provider?.stale ? 'state-pill-stale' : 'state-pill-waiting_review'}`}>
            {provider?.status === 'error' ? 'error' : provider?.refreshing ? 'refreshing' : provider?.stale ? 'stale' : 'ready'}
          </span>
        </div>

        <div className="usage-provider-hero-grid">
          <div className="usage-provider-big-number">
            <div className="section-title">Weekly left</div>
            <div className={`usage-big-percent ${paceClass(weekly)}`}>{percentage(weekly?.remainingPercent)}</div>
            <div className="muted">resets {durationLabel(weekly?.resetsAt)} from now</div>
            <div className="usage-reset-absolute">{weekly?.resetsAt ? formatFriendlyDateTime(weekly.resetsAt) : '—'}</div>
          </div>
          <div className="usage-provider-hero-side">
            <div className="usage-insight-chip">
              <TrendingUp size={14} />
              {weekly?.paceSource === 'provider' ? 'provider opinion' : 'computed opinion'}
            </div>
            <div className="usage-mini-stat-row">
              <span>Reserve</span>
              <strong>{typeof weekly?.reservePercent === 'number' ? `${weekly.reservePercent}%` : '—'}</strong>
            </div>
            <div className="usage-mini-stat-row">
              <span>Expected used</span>
              <strong>{typeof weekly?.expectedUsedPercent === 'number' ? `${weekly.expectedUsedPercent}%` : '—'}</strong>
            </div>
            <div className="usage-mini-stat-row">
              <span>Updated</span>
              <strong>{provider?.fetchedAt ? relativeTime(provider.fetchedAt) : '—'}</strong>
            </div>
          </div>
        </div>

        <div className="usage-provider-divider" />
        <div className="usage-meter-stack">
          <Meter label="Weekly window" window={weekly} emphasizePace />
          <Meter label="5 hour window" window={short} />
          {extended ? <Meter label="Extra window" window={extended} /> : null}
        </div>
      </AppCard>

      <AppCard className="usage-provider-card usage-history-card">
        <div className="usage-card-title-row">
          <div>
            <div className="section-title">History</div>
            <div className="decision-title">Weekly remaining trend</div>
          </div>
        </div>
        <Sparkline points={history.slice(-24)} />
      </AppCard>

      <AppCard className="usage-provider-card">
        <div className="usage-card-title-row">
          <div>
            <div className="section-title">Details</div>
            <div className="decision-title">Readable, not raw</div>
          </div>
        </div>
        <div className="usage-detail-grid">
          <div className="usage-detail-item">
            <span className="meta-label">Weekly reset</span>
            <strong>{weekly?.resetsAt ? formatFriendlyDateTime(weekly.resetsAt) : '—'}</strong>
          </div>
          <div className="usage-detail-item">
            <span className="meta-label">5h reset</span>
            <strong>{short?.resetsAt ? formatFriendlyDateTime(short.resetsAt) : '—'}</strong>
          </div>
          <div className="usage-detail-item">
            <span className="meta-label">Weekly status</span>
            <strong className={paceClass(weekly)}>{paceLabel(weekly)}</strong>
          </div>
          <div className="usage-detail-item">
            <span className="meta-label">5h left</span>
            <strong className={paceClass(statusTone)}>{percentage(short?.remainingPercent)}</strong>
          </div>
          <div className="usage-detail-item">
            <span className="meta-label">Source</span>
            <strong>{provider?.source || '—'}</strong>
          </div>
          <div className="usage-detail-item">
            <span className="meta-label">Version</span>
            <strong>{provider?.version || '—'}</strong>
          </div>
          <div className="usage-detail-item">
            <span className="meta-label">Login</span>
            <strong>{provider?.loginMethod || provider?.providerID || '—'}</strong>
          </div>
          <div className="usage-detail-item">
            <span className="meta-label">Account</span>
            <strong>{provider?.accountEmail || '—'}</strong>
          </div>
        </div>
        {provider?.error ? <div className="error-text">{provider.error}</div> : null}
      </AppCard>
    </section>
  );
}

export function UsagePage() {
  const [usage, setUsage] = useState<UsageSnapshot>();
  const [history, setHistory] = useState<UsageHistoryPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const [usageResponse, historyResponse] = await Promise.all([loadUsageSnapshot(), loadUsageHistory()]);
      setUsage(usageResponse.usage);
      setHistory(historyResponse.history);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'usage_load_failed');
    } finally {
      setLoading(false);
    }
  };

  const forceRefresh = async () => {
    setRefreshing(true);
    try {
      const usageResponse = await forceRefreshUsageSnapshot();
      const historyResponse = await loadUsageHistory();
      setUsage(usageResponse.usage);
      setHistory(historyResponse.history);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'usage_refresh_failed');
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { void load(); }, 10_000);
    return () => window.clearInterval(timer);
  }, []);

  const historyByProvider = useMemo(() => ({
    claude: history.filter((point) => point.provider === 'claude'),
    codex: history.filter((point) => point.provider === 'codex'),
  }), [history]);

  return (
    <div className="page-shell jarvis-shell usage-page-shell">
      <header className="cockpit-header-card">
        <div className="cockpit-title-block">
          <div className="eyebrow-row"><BarChart3 size={14} /> AI usage</div>
          <h2>Claude and Codex capacity</h2>
          <p>Fast shared cache, friendlier dates, provider pace opinion, and persisted history for trend lines.</p>
        </div>
        <div className="toolbar-row compact-toolbar">
          <Button size="sm" variant="secondary" onClick={() => void load()} disabled={loading || refreshing}><RefreshCw size={14} /> Reload view</Button>
          <Button size="sm" onClick={() => void forceRefresh()} disabled={refreshing}><RefreshCw size={14} /> Force refresh cache</Button>
        </div>
      </header>

      <div className="usage-columns-layout usage-columns-layout-visual">
        <ProviderColumn label="Claude" provider={usage?.providers.claude} history={historyByProvider.claude} />
        <ProviderColumn label="Codex" provider={usage?.providers.codex} history={historyByProvider.codex} />
      </div>

      {usage?.refreshing ? <div className="muted">Cache refresh is running in the background.</div> : null}
      {loading && !usage?.hasAnyData ? <div className="muted">Loading usage cache… first run can take a while because Claude is slow.</div> : null}
      {error ? <div className="error-text">{error}</div> : null}
    </div>
  );
}
