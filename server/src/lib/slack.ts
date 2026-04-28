import type { SlackThreadSummary } from '../types.js';
import { getSlackBotToken, getSlackWorkspaceUrl } from './openclaw.js';

const cache = new Map<string, { at: number; value: SlackThreadSummary }>();
const TTL_MS = 30_000;
const SLACK_TIMEOUT_MS = 2200;
let runtimeWorkspaceUrl: string | undefined;
let workspaceUrlInflight: Promise<string | undefined> | null = null;

export function buildSlackPermalink(channel: string, ts: string, workspaceUrl?: string) {
  const base = workspaceUrl || runtimeWorkspaceUrl || getSlackWorkspaceUrl();
  if (!base) return undefined;
  return `${base.replace(/\/$/, '')}/archives/${channel}/p${ts.replace('.', '')}?thread_ts=${ts}&cid=${channel}`;
}

async function slackApi(method: string, token: string, body: URLSearchParams) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SLACK_TIMEOUT_MS);
  try {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body,
      signal: controller.signal
    });
    return res.json() as Promise<any>;
  } finally {
    clearTimeout(timeout);
  }
}

async function ensureWorkspaceUrl(token: string) {
  if (runtimeWorkspaceUrl) return runtimeWorkspaceUrl;
  const configured = getSlackWorkspaceUrl();
  if (configured) {
    runtimeWorkspaceUrl = configured;
    return runtimeWorkspaceUrl;
  }
  if (workspaceUrlInflight) return workspaceUrlInflight;
  workspaceUrlInflight = slackApi('auth.test', token, new URLSearchParams())
    .then((result) => {
      runtimeWorkspaceUrl = typeof result?.url === 'string' ? result.url : undefined;
      return runtimeWorkspaceUrl;
    })
    .catch(() => undefined)
    .finally(() => {
      workspaceUrlInflight = null;
    });
  return workspaceUrlInflight;
}

export async function primeSlackWorkspaceUrl() {
  const token = getSlackBotToken();
  if (!token) return getSlackWorkspaceUrl();
  return ensureWorkspaceUrl(token);
}

export async function fetchSlackThreadSummary(channel: string | undefined, ts: string | undefined): Promise<SlackThreadSummary> {
  if (!channel || !ts) return {};
  const key = `${channel}:${ts}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;

  const token = getSlackBotToken();
  if (!token) {
    return { permalink: buildSlackPermalink(channel, ts), error: 'missing_slack_bot_token' };
  }

  const workspaceUrl = await ensureWorkspaceUrl(token);
  const fallbackPermalink = buildSlackPermalink(channel, ts, workspaceUrl);

  try {
    const replies = await slackApi('conversations.replies', token, new URLSearchParams({ channel, ts, inclusive: 'true', limit: '1' }));
    const first = replies.messages?.[0];
    const value: SlackThreadSummary = {
      permalink: fallbackPermalink,
      starterMessage: first?.text,
      starterUser: first?.user,
      fetchedAt: new Date().toISOString(),
      error: replies.ok ? undefined : replies.error
    };
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch (error) {
    return {
      permalink: fallbackPermalink,
      error: error instanceof Error ? error.message : 'slack_fetch_failed'
    };
  }
}
