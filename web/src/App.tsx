import { BarChart3, CalendarClock, LayoutPanelTop, PanelRightOpen, TerminalSquare } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import { loadJobs, loadUsageSnapshot, usageWindowTone } from './lib';
import { CockpitPage } from './pages/CockpitPage';
import { CronsPage } from './pages/CronsPage';
import { OpenClawPage } from './pages/OpenClawPage';
import { SystemTerminalPage } from './pages/SystemTerminalPage';
import { UsagePage } from './pages/UsagePage';
import type { UsageSnapshot, UsageProviderSnapshot } from './types';

function shortTimeUntil(input?: string) {
  if (!input) return '--';
  const diffMs = new Date(input).getTime() - Date.now();
  if (diffMs <= 0) return 'now';
  const totalHours = Math.floor(diffMs / 3_600_000);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  if (days > 0) return `${days}d${hours > 0 ? `${hours}h` : ''}`;
  const minutes = Math.floor((diffMs % 3_600_000) / 60_000);
  return `${totalHours}h${minutes > 0 ? `${minutes}m` : ''}`;
}

function usageSummaryLabel(label: string, provider?: UsageProviderSnapshot) {
  const remaining = provider?.secondary?.remainingPercent;
  if (typeof remaining !== 'number') return `${label} --`;
  const resetAt = provider?.secondary?.resetsAt;
  return `${label} ${remaining}% ${shortTimeUntil(resetAt)}`;
}

function usageSummaryClass(provider?: UsageProviderSnapshot) {
  const tone = usageWindowTone(provider?.secondary);
  if (tone === 'ok') return 'usage-summary-good';
  if (tone === 'danger') return 'usage-summary-bad';
  return '';
}

export default function App() {
  const [usage, setUsage] = useState<UsageSnapshot>();
  const [activeAgents, setActiveAgents] = useState<number>();

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await loadUsageSnapshot();
        if (!cancelled) setUsage(response.usage);
      } catch {}
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await loadJobs();
        if (!cancelled) setActiveAgents(response.jobs.length);
      } catch {}
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const usageSummary = useMemo(() => {
    const claude = usage?.providers.claude;
    const codex = usage?.providers.codex;
    return {
      claude: usageSummaryLabel('Claude', claude),
      codex: usageSummaryLabel('Codex', codex),
      loading: !usage?.hasAnyData && usage?.refreshing !== false,
    };
  }, [usage]);

  return (
    <div className="app-shell app-shell-single">
      <main className="main-shell main-shell-full app-main-with-nav">
        <div className="app-top-nav-shell">
          <NavLink to="/" end className={({ isActive }) => `app-top-nav-link ${isActive ? 'active' : ''}`}>
            <LayoutPanelTop size={15} /> Workspaces
            <span className="app-top-nav-count">{activeAgents ?? '—'}</span>
          </NavLink>
          <NavLink to="/openclaw" className={({ isActive }) => `app-top-nav-link ${isActive ? 'active' : ''}`}>
            <PanelRightOpen size={15} /> OpenClaw
          </NavLink>
          <NavLink to="/terminal" className={({ isActive }) => `app-top-nav-link ${isActive ? 'active' : ''}`}>
            <TerminalSquare size={15} /> Terminal
          </NavLink>
          <NavLink to="/usage" className={({ isActive }) => `app-top-nav-link ${isActive ? 'active' : ''}`}>
            <BarChart3 size={15} /> Usage
          </NavLink>
          <NavLink to="/crons" className={({ isActive }) => `app-top-nav-link ${isActive ? 'active' : ''}`}>
            <CalendarClock size={15} /> Crons
          </NavLink>
          <div className="app-top-nav-usage-summary">
            <span className={usageSummaryClass(usage?.providers.claude)}>{usageSummary.claude}</span>
            <span className={usageSummaryClass(usage?.providers.codex)}>{usageSummary.codex}</span>
          </div>
        </div>
        <div className="app-page-slot">
          <Routes>
            <Route path="/" element={<CockpitPage />} />
            <Route path="/openclaw" element={<OpenClawPage />} />
            <Route path="/terminal" element={<SystemTerminalPage />} />
            <Route path="/usage" element={<UsagePage />} />
            <Route path="/crons" element={<CronsPage />} />
          </Routes>
        </div>
      </main>
    </div>
  );
}
