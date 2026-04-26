import { ExternalLink, RadioTower, TerminalSquare } from 'lucide-react';
import { useEffect, useState } from 'react';
import { AppCard, Button, MetaRow } from '../components/ui';
import { openHomeTerminal } from '../lib';
import type { TerminalRecord } from '../types';

export function SystemTerminalPage() {
  const [terminal, setTerminal] = useState<TerminalRecord>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadTerminal = async () => {
    setLoading(true);
    try {
      const response = await openHomeTerminal();
      setTerminal(response.terminal);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'home_terminal_failed');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadTerminal();
  }, []);

  return (
    <div className="page-shell terminal-shell jarvis-shell system-terminal-page">
      <header className="cockpit-header-card">
        <div className="cockpit-title-block">
          <div className="eyebrow-row"><TerminalSquare size={14} /> Home terminal</div>
          <h2>~/</h2>
          <p>A full-screen shell already dropped into home.</p>
        </div>
        <div className="toolbar-row compact-toolbar">
          <Button size="sm" onClick={() => void loadTerminal()}><RadioTower size={14} /> Restart terminal</Button>
          {terminal?.url ? <a className="inline-link" href={terminal.url}><ExternalLink size={14} /> Open raw terminal</a> : null}
        </div>
      </header>

      <AppCard className="detail-grid compact-detail-grid">
        <MetaRow label="Directory" value={terminal?.worktreePath || '—'} mono />
        <MetaRow label="Kind" value={terminal?.kind || '—'} mono />
      </AppCard>

      {terminal?.url ? <iframe className="terminal-frame system-terminal-frame" src={terminal.url} title="home terminal" /> : <div className="terminal-empty">{loading ? 'Starting shell…' : 'Terminal unavailable.'}</div>}
      {error ? <div className="error-text">{error}</div> : null}
    </div>
  );
}
