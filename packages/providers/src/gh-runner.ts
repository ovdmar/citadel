import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  GhRateLimitedError,
  getGhCooldownReason,
  getGhCooldownUntil,
  isRateLimitError,
  setGhCooldown,
} from "./gh-cooldown.js";

const execFileAsync = promisify(execFile);

let githubCommandOverride = "gh";

export function setGithubCommand(command: string | undefined) {
  githubCommandOverride = command?.length ? command : "gh";
}

// Global gh rate-limit circuit breaker. The cooldown state lives in
// ./gh-cooldown.ts; every provider path that shells out to gh should use this
// runner so one cooldown gate covers PR view, CI, auth status, merge, etc.
export async function gh(rootPath: string, args: string[]) {
  const until = getGhCooldownUntil();
  if (until > Date.now()) {
    throw new GhRateLimitedError(until, getGhCooldownReason() ?? "rate limit");
  }
  try {
    const result = await execFileAsync(githubCommandOverride, args, {
      cwd: rootPath,
      timeout: 12000,
      maxBuffer: 1024 * 1024,
    });
    return result.stdout.trim();
  } catch (error) {
    const reason = isRateLimitError(error);
    if (reason) {
      const newUntil = setGhCooldown(reason);
      throw new GhRateLimitedError(newUntil, reason);
    }
    throw error;
  }
}
