import { AlertTriangle, CalendarClock, CheckCircle2, PauseCircle, Play, RefreshCw, Rocket } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { AppCard, Button, Field, KpiPill, MetaRow, Surface } from '../components/ui';
import { loadCronDetail, loadCrons, relativeTime, runCron, setCronEnabled } from '../lib';
import type { CronRecord, CronRunEntry } from '../types';

function useIsMobile(breakpoint = 820) {
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' ? window.innerWidth <= breakpoint : false);

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth <= breakpoint);
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [breakpoint]);

  return isMobile;
}

function formatAbsolute(input?: string | number) {
  if (!input) return '—';
  const value = typeof input === 'number' ? new Date(input) : new Date(input);
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(value);
}

function cronHealthLabel(cron: CronRecord) {
  switch (cron.health) {
    case 'failing': return 'Failing';
    case 'disabled': return 'Disabled';
    case 'pending': return 'Pending';
    case 'completed': return 'Completed';
    default: return 'Healthy';
  }
}

function cronHealthClass(cron: CronRecord) {
  switch (cron.health) {
    case 'failing': return 'cron-health-failing';
    case 'disabled': return 'cron-health-disabled';
    case 'pending': return 'cron-health-pending';
    case 'completed': return 'cron-health-completed';
    default: return 'cron-health-healthy';
  }
}

function cronTopSignal(cron: CronRecord) {
  if (!cron.enabled) return 'Disabled, will not run until re-enabled.';
  if ((cron.state?.consecutiveErrors || 0) > 0) return `${cron.state?.consecutiveErrors} consecutive errors need attention.`;
  if (cron.schedule?.kind === 'at' && !cron.lastRunAt) return `One-shot pending for ${formatAbsolute(cron.nextRunAt || cron.schedule?.at)}.`;
  if (cron.schedule?.kind === 'at' && cron.lastRunAt) return `One-shot completed ${relativeTime(cron.lastRunAt)}.`;
  return `Next run ${relativeTime(cron.nextRunAt)}.`;
}

function runSummary(run: CronRunEntry) {
  const parts = [run.status || run.action || 'unknown'];
  if (run.durationMs) parts.push(`${Math.round(run.durationMs / 1000)}s`);
  if (run.deliveryStatus) parts.push(run.deliveryStatus);
  return parts.join(' · ');
}

export function CronsPage() {
  const [crons, setCrons] = useState<CronRecord[]>([]);
  const [selectedCronId, setSelectedCronId] = useState<string>('');
  const [selectedCron, setSelectedCron] = useState<CronRecord | undefined>();
  const [runs, setRuns] = useState<CronRunEntry[]>([]);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [error, setError] = useState('');
  const [mobileView, setMobileView] = useState<'list' | 'detail'>('list');
  const [enabledFilter, setEnabledFilter] = useState<'all' | 'enabled' | 'disabled'>('all');
  const [healthFilter, setHealthFilter] = useState<'all' | 'healthy' | 'failing' | 'disabled' | 'pending'>('all');
  const [targetFilter, setTargetFilter] = useState<'all' | 'isolated' | 'main' | 'current' | 'session'>('all');
  const [sortBy, setSortBy] = useState<'attention' | 'next' | 'name'>('attention');
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const isMobile = useIsMobile();

  const refresh = async () => {
    try {
      const response = await loadCrons();
      setCrons(response.crons);
      setSelectedCronId((current) => current || response.crons[0]?.id || '');
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed_to_load_crons');
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const filteredCrons = useMemo(() => {
    const list = crons.filter((cron) => {
      if (enabledFilter === 'enabled' && !cron.enabled) return false;
      if (enabledFilter === 'disabled' && cron.enabled) return false;
      if (healthFilter !== 'all' && cron.health !== healthFilter) return false;
      if (targetFilter !== 'all') {
        if (targetFilter === 'session' && !(cron.sessionTarget || '').startsWith('session:')) return false;
        if (targetFilter !== 'session' && cron.sessionTarget !== targetFilter) return false;
      }
      return true;
    });

    const score = (cron: CronRecord) => {
      if (cron.health === 'failing') return 0;
      if (cron.health === 'disabled') return 1;
      if (cron.health === 'pending') return 2;
      if (cron.health === 'completed') return 4;
      return 3;
    };

    return list.sort((a, b) => {
      if (sortBy === 'name') return (a.name || a.id).localeCompare(b.name || b.id);
      if (sortBy === 'next') return new Date(a.nextRunAt || a.schedule?.at || 0).getTime() - new Date(b.nextRunAt || b.schedule?.at || 0).getTime();
      const byScore = score(a) - score(b);
      if (byScore !== 0) return byScore;
      return new Date(a.nextRunAt || a.schedule?.at || 0).getTime() - new Date(b.nextRunAt || b.schedule?.at || 0).getTime();
    });
  }, [crons, enabledFilter, healthFilter, targetFilter, sortBy]);

  const currentCron = filteredCrons.find((cron) => cron.id === selectedCronId) || filteredCrons[0];

  useEffect(() => {
    if (!currentCron) {
      setSelectedCron(undefined);
      setRuns([]);
      return;
    }
    setSelectedCronId(currentCron.id);
    setLoadingDetail(true);
    let cancelled = false;
    (async () => {
      try {
        const detail = await loadCronDetail(currentCron.id);
        if (cancelled) return;
        setSelectedCron(detail.cron);
        setRuns(detail.runs);
      } catch {
        if (cancelled) return;
        setSelectedCron(currentCron);
        setRuns([]);
      } finally {
        if (!cancelled) setLoadingDetail(false);
      }
    })();
    return () => { cancelled = true; };
  }, [currentCron?.id]);

  useEffect(() => {
    if (!isMobile) {
      setMobileView('list');
      setMobileFiltersOpen(false);
    }
  }, [isMobile]);

  const failingCount = crons.filter((cron) => cron.health === 'failing').length;
  const disabledCount = crons.filter((cron) => cron.health === 'disabled').length;
  const pendingCount = crons.filter((cron) => cron.health === 'pending').length;
  const healthyCount = crons.filter((cron) => cron.health === 'healthy' || cron.health === 'completed').length;

  const handleRunNow = async (cronId: string) => {
    await runCron(cronId);
    await refresh();
  };

  const handleToggle = async (cronId: string, enabled: boolean) => {
    await setCronEnabled(cronId, enabled);
    await refresh();
  };

  if (isMobile) {
    return (
      <div className="page-shell jarvis-shell mobile-citadel-shell">
        <header className={`cockpit-header-card mobile-header-card ${mobileView === 'detail' ? 'detail' : ''}`}>
          <div className="cockpit-title-block">
            <div className="eyebrow-row"><CalendarClock size={14} /> Citadel crons</div>
            <h2>{mobileView === 'detail' ? (selectedCron?.name || 'Cron detail') : 'Crons'}</h2>
            <p>{mobileView === 'detail' ? cronTopSignal(selectedCron || currentCron || {} as CronRecord) : `${filteredCrons.length} visible`}</p>
            {error ? <p className="error-text">{error}</p> : null}
          </div>
          <div className="mobile-header-actions">
            {mobileView === 'detail' ? <Button variant="ghost" size="sm" onClick={() => setMobileView('list')}>Back</Button> : null}
            <Button size="sm" variant="secondary" onClick={() => void refresh()}><RefreshCw size={14} /> Refresh</Button>
            {mobileView === 'list' ? <Button size="sm" variant="ghost" onClick={() => setMobileFiltersOpen((open) => !open)}>{mobileFiltersOpen ? 'Hide filters' : 'Filters'}</Button> : null}
          </div>
        </header>

        <section className="kpi-strip">
          <KpiPill value={<><AlertTriangle size={15} /> {failingCount}</>} label="failing" tone={failingCount ? 'danger' : 'neutral'} />
          <KpiPill value={<><PauseCircle size={15} /> {disabledCount}</>} label="disabled" tone={disabledCount ? 'warn' : 'neutral'} />
          <KpiPill value={<><CalendarClock size={15} /> {pendingCount}</>} label="one-shot" tone={pendingCount ? 'accent' : 'neutral'} />
          <KpiPill value={<><CheckCircle2 size={15} /> {healthyCount}</>} label="healthy" tone="accent" />
        </section>

        {mobileView === 'list' ? (
          <>
            {mobileFiltersOpen ? (
              <div className="workspace-filters mobile-filters-card">
                <Field value={enabledFilter} onChange={(e) => setEnabledFilter(e.target.value as typeof enabledFilter)}>
                  <option value="all">All enabled states</option>
                  <option value="enabled">Enabled only</option>
                  <option value="disabled">Disabled only</option>
                </Field>
                <Field value={healthFilter} onChange={(e) => setHealthFilter(e.target.value as typeof healthFilter)}>
                  <option value="all">All health</option>
                  <option value="healthy">Healthy</option>
                  <option value="failing">Failing</option>
                  <option value="disabled">Disabled</option>
                  <option value="pending">Pending one-shot</option>
                </Field>
                <Field value={targetFilter} onChange={(e) => setTargetFilter(e.target.value as typeof targetFilter)}>
                  <option value="all">All targets</option>
                  <option value="isolated">Isolated</option>
                  <option value="main">Main</option>
                  <option value="current">Current</option>
                  <option value="session">Named session</option>
                </Field>
                <Field value={sortBy} onChange={(e) => setSortBy(e.target.value as typeof sortBy)}>
                  <option value="attention">Needs attention</option>
                  <option value="next">Next run</option>
                  <option value="name">Name</option>
                </Field>
              </div>
            ) : null}
            <div className="mobile-workspace-list">
              {filteredCrons.map((cron) => (
                <button key={cron.id} className="workspace-row cron-row" onClick={() => { setSelectedCronId(cron.id); setMobileView('detail'); }}>
                  <div className="mobile-workspace-card-body">
                    <div className="job-key">{cron.sessionTarget || 'cron'}</div>
                    <div className="workspace-title">{cron.name || cron.id}</div>
                    <div className="workspace-subtle">{cronTopSignal(cron)}</div>
                    <div className="cron-mini-meta">
                      <span className={`cron-health-pill ${cronHealthClass(cron)}`}>{cronHealthLabel(cron)}</span>
                      <span>{cron.scheduleLabel}</span>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </>
        ) : selectedCron ? (
          <div className="mobile-stats-stack">
            <AppCard>
              <div className="mobile-hero-topline">
                <div>
                  <div className="section-title">Cron overview</div>
                  <div className="decision-title">{selectedCron.name || selectedCron.id}</div>
                </div>
                <span className={`cron-health-pill ${cronHealthClass(selectedCron)}`}>{cronHealthLabel(selectedCron)}</span>
              </div>
              <div className="decision-body">{selectedCron.description || cronTopSignal(selectedCron)}</div>
              <div className="mobile-meta-list">
                <span>{selectedCron.scheduleLabel}</span>
                <span>{selectedCron.sessionTarget || 'no target'}</span>
                <span>{selectedCron.payload?.kind || 'unknown payload'}</span>
              </div>
              <div className="side-action-row">
                <Button size="sm" variant="secondary" onClick={() => void handleRunNow(selectedCron.id)}><Rocket size={14} /> Run now</Button>
                <Button size="sm" variant="ghost" onClick={() => void handleToggle(selectedCron.id, !selectedCron.enabled)}>{selectedCron.enabled ? 'Disable' : 'Enable'}</Button>
              </div>
            </AppCard>

            <AppCard>
              <div className="section-title">Status</div>
              <div className="detail-grid compact-detail-grid">
                <Surface><MetaRow label="Next run" value={selectedCron.nextRunAt ? `${relativeTime(selectedCron.nextRunAt)} (${formatAbsolute(selectedCron.nextRunAt)})` : '—'} /></Surface>
                <Surface><MetaRow label="Last run" value={selectedCron.lastRunAt ? `${relativeTime(selectedCron.lastRunAt)} (${formatAbsolute(selectedCron.lastRunAt)})` : '—'} /></Surface>
                <Surface><MetaRow label="Errors" value={String(selectedCron.state?.consecutiveErrors || 0)} /></Surface>
                <Surface><MetaRow label="Delivery" value={selectedCron.state?.lastDeliveryStatus || '—'} /></Surface>
              </div>
            </AppCard>

            <AppCard>
              <div className="section-title">Recent runs</div>
              <div className="cron-runs-list">
                {loadingDetail ? <div className="muted">Loading runs…</div> : runs.length ? runs.map((run) => (
                  <div key={`${run.ts}-${run.jobId}`} className="cron-run-item">
                    <div className="cron-run-topline">
                      <strong>{runSummary(run)}</strong>
                      <span>{formatAbsolute(run.runAtMs || run.ts)}</span>
                    </div>
                    <div className="workspace-subtle">{run.model ? `${run.provider || 'model'} · ${run.model}` : (run.sessionKey || 'No session key')}</div>
                  </div>
                )) : <div className="muted">No recent runs loaded.</div>}
              </div>
            </AppCard>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="page-shell jarvis-shell superset-shell">
      <header className="cockpit-header-card">
        <div className="cockpit-title-block">
          <div className="eyebrow-row"><CalendarClock size={14} /> Automation cockpit</div>
          <h2>Crons</h2>
          <p>Manage scheduled OpenClaw automation with the same operator-first view as workspaces.</p>
          {error ? <p className="error-text">{error}</p> : null}
        </div>
        <div className="toolbar-row compact-toolbar">
          <Button size="sm" variant="secondary" onClick={() => void refresh()}><RefreshCw size={14} /> Refresh</Button>
        </div>
      </header>

      <section className="kpi-strip">
        <KpiPill value={<><AlertTriangle size={15} /> {failingCount}</>} label="failing" tone={failingCount ? 'danger' : 'neutral'} />
        <KpiPill value={<><PauseCircle size={15} /> {disabledCount}</>} label="disabled" tone={disabledCount ? 'warn' : 'neutral'} />
        <KpiPill value={<><CalendarClock size={15} /> {pendingCount}</>} label="one-shot pending" tone={pendingCount ? 'accent' : 'neutral'} />
        <KpiPill value={<><CheckCircle2 size={15} /> {healthyCount}</>} label="healthy" tone="accent" />
      </section>

      <div className="superset-layout cron-layout">
        <aside className="workspace-nav-pane">
          <div className="workspace-nav-top">
            <div>
              <div className="eyebrow-row">Cron jobs</div>
              <h2 className="workspace-pane-title">Needs attention first</h2>
            </div>
          </div>
          <div className="workspace-filters">
            <Field value={enabledFilter} onChange={(e) => setEnabledFilter(e.target.value as typeof enabledFilter)}>
              <option value="all">All enabled states</option>
              <option value="enabled">Enabled only</option>
              <option value="disabled">Disabled only</option>
            </Field>
            <Field value={healthFilter} onChange={(e) => setHealthFilter(e.target.value as typeof healthFilter)}>
              <option value="all">All health</option>
              <option value="healthy">Healthy</option>
              <option value="failing">Failing</option>
              <option value="disabled">Disabled</option>
              <option value="pending">Pending one-shot</option>
            </Field>
            <Field value={targetFilter} onChange={(e) => setTargetFilter(e.target.value as typeof targetFilter)}>
              <option value="all">All targets</option>
              <option value="isolated">Isolated</option>
              <option value="main">Main</option>
              <option value="current">Current</option>
              <option value="session">Named session</option>
            </Field>
            <Field value={sortBy} onChange={(e) => setSortBy(e.target.value as typeof sortBy)}>
              <option value="attention">Needs attention</option>
              <option value="next">Next run</option>
              <option value="name">Name</option>
            </Field>
          </div>
          <div className="workspace-list-rail">
            {filteredCrons.map((cron) => (
              <button key={cron.id} className={`workspace-nav-item ${currentCron?.id === cron.id ? 'selected' : ''}`} onClick={() => setSelectedCronId(cron.id)}>
                <div className="workspace-nav-topline">
                  <span className="job-key">{cron.sessionTarget || 'cron'}</span>
                  <span className={`cron-health-pill ${cronHealthClass(cron)}`}>{cronHealthLabel(cron)}</span>
                </div>
                <div className="workspace-nav-title">{cron.name || cron.id}</div>
                <div className="workspace-nav-meta">{cron.scheduleLabel}</div>
                <div className="workspace-subtle">{cronTopSignal(cron)}</div>
              </button>
            ))}
          </div>
        </aside>

        <section className="workspace-stream-pane cron-detail-pane">
          {selectedCron ? (
            <>
              <AppCard className="side-top-card">
                <div className="overview-card-toprow">
                  <div>
                    <div className="section-title">Cron overview</div>
                    <div className="decision-title">{selectedCron.name || selectedCron.id}</div>
                  </div>
                  <span className={`cron-health-pill ${cronHealthClass(selectedCron)}`}>{cronHealthLabel(selectedCron)}</span>
                </div>
                <div className="decision-body">{selectedCron.description || cronTopSignal(selectedCron)}</div>
                <div className="git-status-summary">
                  <span>{selectedCron.scheduleLabel}</span>
                  <span>{selectedCron.sessionTarget || 'no target'}</span>
                  <span>{selectedCron.payload?.kind || 'unknown payload'}</span>
                  {selectedCron.delivery?.mode ? <span>delivery {selectedCron.delivery.mode}</span> : null}
                </div>
                <div className="side-action-row">
                  <Button size="sm" variant="secondary" onClick={() => void handleRunNow(selectedCron.id)}><Rocket size={14} /> Run now</Button>
                  <Button size="sm" variant="ghost" onClick={() => void handleToggle(selectedCron.id, !selectedCron.enabled)}>{selectedCron.enabled ? 'Disable' : 'Enable'}</Button>
                </div>
              </AppCard>

              <AppCard className="side-top-card">
                <div className="section-title">Status</div>
                <div className="detail-grid compact-detail-grid">
                  <Surface><MetaRow label="Next run" value={selectedCron.nextRunAt ? `${relativeTime(selectedCron.nextRunAt)} (${formatAbsolute(selectedCron.nextRunAt)})` : '—'} /></Surface>
                  <Surface><MetaRow label="Last run" value={selectedCron.lastRunAt ? `${relativeTime(selectedCron.lastRunAt)} (${formatAbsolute(selectedCron.lastRunAt)})` : '—'} /></Surface>
                  <Surface><MetaRow label="Errors" value={String(selectedCron.state?.consecutiveErrors || 0)} /></Surface>
                  <Surface><MetaRow label="Last status" value={selectedCron.state?.lastStatus || '—'} /></Surface>
                  <Surface><MetaRow label="Delivery" value={selectedCron.state?.lastDeliveryStatus || '—'} /></Surface>
                  <Surface><MetaRow label="Timeout" value={selectedCron.payload?.timeoutSeconds ? `${selectedCron.payload.timeoutSeconds}s` : '—'} /></Surface>
                </div>
              </AppCard>

              <AppCard className="side-top-card">
                <div className="section-title">Payload and delivery</div>
                <pre>{JSON.stringify({
                  sessionTarget: selectedCron.sessionTarget,
                  wakeMode: selectedCron.wakeMode,
                  payload: selectedCron.payload,
                  delivery: selectedCron.delivery,
                  failureAlert: selectedCron.failureAlert
                }, null, 2)}</pre>
              </AppCard>
            </>
          ) : <AppCard className="stream-placeholder">Select a cron.</AppCard>}
        </section>

        <aside className="workspace-side-pane">
          <AppCard className="side-top-card">
            <div className="section-title">Recent runs</div>
            <div className="cron-runs-list">
              {loadingDetail ? <div className="muted">Loading runs…</div> : runs.length ? runs.map((run) => (
                <div key={`${run.ts}-${run.jobId}`} className="cron-run-item">
                  <div className="cron-run-topline">
                    <strong>{runSummary(run)}</strong>
                    <span>{formatAbsolute(run.runAtMs || run.ts)}</span>
                  </div>
                  <div className="workspace-subtle">{run.model ? `${run.provider || 'model'} · ${run.model}` : (run.sessionKey || 'No session key')}</div>
                </div>
              )) : <div className="muted">No recent runs loaded.</div>}
            </div>
          </AppCard>
        </aside>
      </div>
    </div>
  );
}
