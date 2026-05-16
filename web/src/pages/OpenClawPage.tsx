import { ExternalLink, PanelRightOpen, RefreshCw, RadioTower } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { AppCard, Button, KpiPill, MetaRow, Surface } from '../components/ui';
import { formatTime, loadOpenClawStats, openOpenClawTerminal } from '../lib';
import type { OpenClawStats } from '../types';

function recentSessionLabel(stats?: OpenClawStats) {
  const session = stats?.sessions.recent?.[0];
  if (!session?.updatedAt) return '—';
  return formatTime(new Date(session.updatedAt).toISOString());
}

export function OpenClawPage() {
  const [url, setUrl] = useState('');
  const [stats, setStats] = useState<OpenClawStats>();
  const [terminalLoading, setTerminalLoading] = useState(true);
  const [statsLoading, setStatsLoading] = useState(true);
  const [error, setError] = useState('');

  const loadTerminal = async () => {
    setTerminalLoading(true);
    try {
      const response = await openOpenClawTerminal();
      setUrl(response.terminal.url);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'openclaw_terminal_failed');
    } finally {
      setTerminalLoading(false);
    }
  };

  const refreshStats = async (quiet = false) => {
    if (!quiet) setStatsLoading(true);
    try {
      const response = await loadOpenClawStats();
      setStats(response.stats);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'openclaw_stats_failed');
    } finally {
      setStatsLoading(false);
    }
  };

  useEffect(() => {
    void Promise.all([loadTerminal(), refreshStats()]);
    const timer = window.setInterval(() => {
      void refreshStats(true);
    }, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const channelSummary = useMemo(() => (stats?.channels || []).slice(0, 4), [stats]);
  const enabledAgents = useMemo(() => (stats?.agents.items || []).filter((item) => item.enabled).length, [stats]);

  return (
    <div className="page-shell terminal-shell jarvis-shell system-terminal-page openclaw-page-shell">
      <header className="cockpit-header-card">
        <div className="cockpit-title-block">
          <div className="eyebrow-row"><PanelRightOpen size={14} /> OpenClaw cockpit</div>
          <h2>openclaw tui</h2>
          <p>Live operator surface on the left, platform health on the right.</p>
        </div>
        <div className="toolbar-row compact-toolbar">
          <Button size="sm" variant="secondary" onClick={() => void refreshStats()}><RefreshCw size={14} /> Refresh stats</Button>
          <Button size="sm" onClick={() => void loadTerminal()}><RadioTower size={14} /> Restart terminal</Button>
        </div>
      </header>

      <section className="kpi-strip">
        <KpiPill value={stats?.gateway.reachable ? 'reachable' : 'offline'} label="gateway" tone={stats?.gateway.reachable ? 'accent' : 'danger'} />
        <KpiPill value={stats?.sessions.count ?? '—'} label="sessions" tone="neutral" />
        <KpiPill value={stats?.tasks.active ?? '—'} label="active tasks" tone="neutral" />
      </section>

      <div className="openclaw-layout">
        <section className="openclaw-terminal-pane">
          {url ? <iframe className="terminal-frame system-terminal-frame" src={url} title="openclaw tui" /> : <div className="terminal-empty">{terminalLoading ? 'Starting openclaw tui…' : 'Terminal unavailable.'}</div>}
        </section>

        <aside className="openclaw-stats-pane">
          <AppCard className="openclaw-stats-card">
            <div className="section-title">Gateway</div>
            <div className="detail-grid compact-detail-grid">
              <MetaRow label="Reachability" value={stats?.gateway.reachable ? 'reachable' : 'offline'} />
              <MetaRow label="Latency" value={typeof stats?.gateway.latencyMs === 'number' ? `${stats.gateway.latencyMs}ms` : '—'} />
              <MetaRow label="Service" value={stats?.gateway.serviceRunning ? 'running' : 'stopped'} />
              <MetaRow label="PID" value={stats?.gateway.pid || '—'} mono />
            </div>
          </AppCard>

          <AppCard className="openclaw-stats-card">
            <div className="section-title">Runtime</div>
            <div className="detail-grid compact-detail-grid">
              <MetaRow label="Version" value={stats?.runtimeVersion || '—'} mono />
              <MetaRow label="Model" value={stats?.sessions.defaultModel || '—'} mono />
              <MetaRow label="Ctx" value={stats?.sessions.contextTokens ? `${Math.round(stats.sessions.contextTokens / 1000)}k` : '—'} />
              <MetaRow label="Last session" value={recentSessionLabel(stats)} />
            </div>
          </AppCard>

          <AppCard className="openclaw-stats-card">
            <div className="section-title">Workload</div>
            <div className="detail-grid compact-detail-grid">
              <MetaRow label="Citadel jobs" value={stats?.citadel.jobs ?? '—'} />
              <MetaRow label="Crons" value={stats?.citadel.crons ?? '—'} />
              <MetaRow label="Browser terminals" value={stats?.citadel.terminals ?? '—'} />
              <MetaRow label="Failures" value={stats?.tasks.failures ?? '—'} />
            </div>
          </AppCard>

          <Surface className="openclaw-stats-card openclaw-channel-list">
            <div className="section-title">Agents and channels</div>
            <div className="muted">{enabledAgents} enabled agents, {stats?.memory.chunkCount ?? 0} memory chunks via {stats?.memory.plugin || '—'}.</div>
            <div className="openclaw-channel-items">
              {channelSummary.map((channel) => (
                <div key={channel.label || channel.state} className="openclaw-channel-item">
                  <div>
                    <strong>{channel.label || 'channel'}</strong>
                    <div className="muted">{channel.detail || '—'}</div>
                  </div>
                  <span className={`state-pill ${channel.state === 'OK' ? 'state-pill-running' : 'state-pill-idle'}`}>{channel.state || 'unknown'}</span>
                </div>
              ))}
            </div>
            {url ? <a className="inline-link" href={url}><ExternalLink size={14} /> Open raw terminal</a> : null}
            {error ? <div className="error-text">{error}</div> : null}
            {statsLoading ? <div className="muted">Refreshing stats…</div> : null}
          </Surface>
        </aside>
      </div>
    </div>
  );
}
