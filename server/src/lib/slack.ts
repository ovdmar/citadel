import type { SlackThreadSummary } from '../types.js';
import { getSlackBotToken, getSlackWorkspaceUrl } from './openclaw.js';

const cache = new Map<string, { at: number; value: SlackThreadSummary }>();
const TTL_MS = 30_000;

async function slackApi(method: string, token: string, body: URLSearchParams) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });
  return res.json() as Promise<any>;
}

export async function fetchSlackThreadSummary(channel: string | undefined, ts: string | undefined): Promise<SlackThreadSummary> {
  if (!channel || !ts) return {};
  const key = `${channel}:${ts}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;

  const token = getSlackBotToken();
  if (!token) {
    return { error: 'missing_slack_bot_token' };
  }

  try {
    const [replies, permalink] = await Promise.all([
      slackApi('conversations.replies', token, new URLSearchParams({ channel, ts, inclusive: 'true', limit: '1' })),
      slackApi('chat.getPermalink', token, new URLSearchParams({ channel, message_ts: ts }))
    ]);

    const first = replies.messages?.[0];
    const workspaceUrl = getSlackWorkspaceUrl();
    const value: SlackThreadSummary = {
      permalink: permalink.permalink || (workspaceUrl ? `${workspaceUrl}/archives/${channel}/p${ts.replace('.', '')}` : undefined),
      starterMessage: first?.text,
      starterUser: first?.user,
      fetchedAt: new Date().toISOString(),
      error: replies.ok && permalink.ok ? undefined : [replies.error, permalink.error].filter(Boolean).join(', ')
    };
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'slack_fetch_failed' };
  }
}
