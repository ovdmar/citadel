import { execFileSync, spawn } from 'node:child_process';
import net from 'node:net';
import { TTYD_BIN, TERMINAL_PORT_BASE, TERMINAL_PORT_MAX } from './config.js';
import type { TerminalSessionRecord } from '../types.js';

const terminalSessions = new Map<string, { record: TerminalSessionRecord; child: ReturnType<typeof spawn> }>();

function hasTmuxSession(session: string) {
  try {
    execFileSync('tmux', ['has-session', '-t', session], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function listTmuxSessions(): string[] {
  try {
    const output = execFileSync('tmux', ['list-sessions', '-F', '#S'], { encoding: 'utf8' });
    return output.split('\n').map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export function captureTmuxTail(session: string, lines = 120): string {
  try {
    return execFileSync('tmux', ['capture-pane', '-t', session, '-p', '-S', `-${lines}`], { encoding: 'utf8' });
  } catch {
    return '';
  }
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

async function findFreePort() {
  for (let port = TERMINAL_PORT_BASE; port <= TERMINAL_PORT_MAX; port += 1) {
    const used = await canConnect(port);
    if (!used) return port;
  }
  throw new Error('no_free_ttyd_port');
}

function shellCommand(tmuxSession: string, worktreePath?: string, recoveryMode = false) {
  const escapedSession = tmuxSession.replace(/"/g, '\\"');
  const escapedWorktree = (worktreePath || process.env.HOME || '/tmp').replace(/"/g, '\\"');
  if (recoveryMode) {
    return `tmux has-session -t \"${escapedSession}\" 2>/dev/null || tmux new-session -d -s \"${escapedSession}\" -c \"${escapedWorktree}\"; tmux attach -t \"${escapedSession}\"`;
  }
  return `tmux attach -t \"${escapedSession}\"`;
}

export async function ensureTerminalSession(params: {
  key: string;
  tmuxSession: string;
  worktreePath?: string;
  host: string;
  recoveryMode?: boolean;
}) {
  const existing = terminalSessions.get(params.key);
  if (existing && existing.child.exitCode == null) {
    existing.record.updatedAt = new Date().toISOString();
    return existing.record;
  }

  if (!params.recoveryMode && !hasTmuxSession(params.tmuxSession)) {
    throw new Error('tmux_session_missing');
  }

  const port = await findFreePort();
  const child = spawn(
    TTYD_BIN,
    ['-W', '--check-origin=false', '-p', String(port), 'zsh', '-lc', shellCommand(params.tmuxSession, params.worktreePath, params.recoveryMode)],
    {
      detached: false,
      stdio: 'ignore'
    }
  );

  const record: TerminalSessionRecord = {
    key: params.key,
    tmuxSession: params.tmuxSession,
    port,
    url: `http://${params.host.split(':')[0]}:${port}`,
    pid: child.pid ?? -1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    recoveryMode: Boolean(params.recoveryMode)
  };

  child.on('exit', () => {
    const current = terminalSessions.get(params.key);
    if (current?.record.pid === record.pid) terminalSessions.delete(params.key);
  });

  terminalSessions.set(params.key, { record, child });
  return record;
}

export function listTerminalSessions() {
  return Array.from(terminalSessions.values())
    .filter((entry) => entry.child.exitCode == null)
    .map((entry) => entry.record);
}
