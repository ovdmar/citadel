import { OPENCLAW_CONFIG_PATH } from './config.js';
import { readJsonFile } from './fs.js';

interface OpenClawConfig {
  channels?: {
    slack?: {
      botToken?: string;
      workspaceUrl?: string;
    };
  };
}

let cached: OpenClawConfig | null = null;

export function getOpenClawConfig() {
  cached ||= readJsonFile<OpenClawConfig>(OPENCLAW_CONFIG_PATH) || {};
  return cached;
}

export function getSlackBotToken() {
  return getOpenClawConfig().channels?.slack?.botToken;
}

export function getSlackWorkspaceUrl() {
  return getOpenClawConfig().channels?.slack?.workspaceUrl;
}
