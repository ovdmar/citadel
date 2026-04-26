import { execFileSync, spawn } from 'node:child_process';
import net from 'node:net';
import { TTYD_BIN, TERMINAL_PORT_BASE, TERMINAL_PORT_MAX } from './config.js';
import type { TerminalSessionRecord } from '../types.js';

const terminalSessions = new Map<string, { record: TerminalSessionRecord; child: ReturnType<typeof spawn> }>();
const reservedPorts = new Set<number>();

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
    if (reservedPorts.has(port)) continue;
    const used = await canConnect(port);
    if (!used && !reservedPorts.has(port)) {
      reservedPorts.add(port);
      return port;
    }
  }
  throw new Error('no_free_ttyd_port');
}

async function waitForPort(port: number, timeoutMs = 2500) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await canConnect(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  return false;
}

function attachTmuxCommand(tmuxSession: string, worktreePath?: string, recoveryMode = false) {
  const escapedSession = tmuxSession.replace(/"/g, '\\"');
  const escapedWorktree = (worktreePath || process.env.HOME || '/tmp').replace(/"/g, '\\"');
  if (recoveryMode) {
    return `tmux has-session -t \"${escapedSession}\" 2>/dev/null || tmux new-session -d -s \"${escapedSession}\" -c \"${escapedWorktree}\"; tmux attach -t \"${escapedSession}\"`;
  }
  return `tmux attach -t \"${escapedSession}\"`;
}

function ensureTmuxSessionExists(tmuxSession: string, directory: string, initialCommand?: string) {
  if (hasTmuxSession(tmuxSession)) return;
  const args = ['new-session', '-d', '-s', tmuxSession, '-c', directory];
  if (initialCommand) args.push(initialCommand);
  execFileSync('tmux', args, { stdio: 'ignore' });
}

function shellWorktreeCommand(worktreePath: string) {
  const escapedWorktree = worktreePath.replace(/"/g, '\\"');
  return `cd \"${escapedWorktree}\" && export PS1='citadel %~ %# ' && exec zsh -i`;
}

function shellDirectoryCommand(directory: string, prompt = 'citadel %~ %# ') {
  const escapedDirectory = directory.replace(/"/g, '\\"');
  const escapedPrompt = prompt.replace(/'/g, `\\'`);
  return `cd \"${escapedDirectory}\" && export PS1='${escapedPrompt}' && exec zsh -i`;
}

function claudeResumeCommand(worktreePath: string, claudeSessionId: string) {
  const escapedWorktree = worktreePath.replace(/"/g, '\\"');
  const escapedSessionId = claudeSessionId.replace(/"/g, '\\"');
  return `cd \"${escapedWorktree}\" && claude --resume \"${escapedSessionId}\"`;
}

function sendClaudeResumeIntoTmux(tmuxSession: string, worktreePath: string, claudeSessionId: string) {
  const command = claudeResumeCommand(worktreePath, claudeSessionId);
  execFileSync('tmux', ['send-keys', '-t', tmuxSession, 'C-c'], { stdio: 'ignore' });
  execFileSync('tmux', ['send-keys', '-t', tmuxSession, '-l', '--', command], { stdio: 'ignore' });
  execFileSync('tmux', ['send-keys', '-t', tmuxSession, 'Enter'], { stdio: 'ignore' });
}

async function spawnTtyd(key: string, host: string, command: string, metadata: Pick<TerminalSessionRecord, 'tmuxSession' | 'worktreePath' | 'recoveryMode' | 'kind'>) {
  const existing = terminalSessions.get(key);
  if (existing && existing.child.exitCode == null) {
    const alive = await canConnect(existing.record.port);
    if (alive) {
      existing.record.updatedAt = new Date().toISOString();
      return existing.record;
    }
    try {
      existing.child.kill('SIGTERM');
    } catch {}
    terminalSessions.delete(key);
  }

  const port = await findFreePort();
  let child: ReturnType<typeof spawn> | undefined;
  try {
    child = spawn(
      TTYD_BIN,
      ['-W', '--check-origin=false', '-p', String(port), 'zsh', '-lc', command],
      {
        detached: false,
        stdio: 'ignore'
      }
    );

    const record: TerminalSessionRecord = {
      key,
      port,
      url: `http://${host.split(':')[0]}:${port}`,
      pid: child.pid ?? -1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...metadata
    };

    child.on('exit', () => {
      reservedPorts.delete(port);
      const current = terminalSessions.get(key);
      if (current?.record.pid === record.pid) terminalSessions.delete(key);
    });

    terminalSessions.set(key, { record, child });

    const ready = await waitForPort(port);
    if (!ready) {
      terminalSessions.delete(key);
      try {
        child.kill('SIGTERM');
      } catch {}
      throw new Error('ttyd_start_timeout');
    }

    return record;
  } finally {
    reservedPorts.delete(port);
    if (!child) reservedPorts.delete(port);
  }
}

export async function ensureCommandSession(params: {
  key: string;
  host: string;
  command: string;
  worktreePath?: string;
}) {
  return spawnTtyd(
    params.key,
    params.host,
    params.command,
    {
      worktreePath: params.worktreePath,
      recoveryMode: false,
      kind: 'command'
    }
  );
}

export async function ensureTerminalSession(params: {
  key: string;
  tmuxSession: string;
  worktreePath?: string;
  host: string;
  recoveryMode?: boolean;
}) {
  if (!params.recoveryMode && !hasTmuxSession(params.tmuxSession)) {
    throw new Error('tmux_session_missing');
  }

  return spawnTtyd(
    params.key,
    params.host,
    attachTmuxCommand(params.tmuxSession, params.worktreePath, params.recoveryMode),
    {
      tmuxSession: params.tmuxSession,
      worktreePath: params.worktreePath,
      recoveryMode: Boolean(params.recoveryMode),
      kind: 'tmux'
    }
  );
}

export async function ensureShellSession(params: {
  key: string;
  worktreePath: string;
  host: string;
}) {
  return spawnTtyd(
    params.key,
    params.host,
    shellWorktreeCommand(params.worktreePath),
    {
      worktreePath: params.worktreePath,
      recoveryMode: false,
      kind: 'shell'
    }
  );
}

export async function ensureHomeShellSession(params: {
  key: string;
  host: string;
  homePath: string;
}) {
  const tmuxSession = 'citadel-system-home';
  ensureTmuxSessionExists(tmuxSession, params.homePath);
  return ensureTerminalSession({
    key: params.key,
    host: params.host,
    tmuxSession,
    worktreePath: params.homePath,
    recoveryMode: false
  });
}

export async function ensureOpenClawTuiSession(params: {
  key: string;
  host: string;
  homePath: string;
}) {
  const tmuxSession = 'citadel-openclaw-tui';
  ensureTmuxSessionExists(tmuxSession, params.homePath, 'openclaw tui');
  return ensureTerminalSession({
    key: params.key,
    host: params.host,
    tmuxSession,
    worktreePath: params.homePath,
    recoveryMode: false
  });
}

export async function ensureClaudeResumeSession(params: {
  key: string;
  tmuxSession: string;
  worktreePath: string;
  claudeSessionId: string;
  host: string;
}) {
  if (!hasTmuxSession(params.tmuxSession)) {
    throw new Error('tmux_session_missing');
  }

  sendClaudeResumeIntoTmux(params.tmuxSession, params.worktreePath, params.claudeSessionId);

  return spawnTtyd(
    params.key,
    params.host,
    attachTmuxCommand(params.tmuxSession, params.worktreePath, false),
    {
      tmuxSession: params.tmuxSession,
      worktreePath: params.worktreePath,
      recoveryMode: true,
      kind: 'tmux'
    }
  );
}

export function listTerminalSessions() {
  return Array.from(terminalSessions.values())
    .filter((entry) => entry.child.exitCode == null)
    .map((entry) => entry.record);
}

export function cleanupCitadelTtyds() {
  try {
    const output = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8' });
    const pids = new Set<number>();
    for (const line of output.split('\n')) {
      if (!line.includes('ttyd')) continue;
      const parts = line.trim().split(/\s+/);
      if (parts.length < 9) continue;
      const pid = Number(parts[1]);
      const name = parts[0];
      const address = parts[8] || '';
      const portMatch = address.match(/:(\d+)$/);
      const port = portMatch ? Number(portMatch[1]) : NaN;
      if (name === 'ttyd' && Number.isFinite(pid) && port >= TERMINAL_PORT_BASE && port <= TERMINAL_PORT_MAX) {
        pids.add(pid);
      }
    }
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {}
    }
    terminalSessions.clear();
    return { killed: pids.size };
  } catch {
    return { killed: 0 };
  }
}
