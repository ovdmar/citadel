import { execFileSync } from "node:child_process";
import type { AgentSession, Repo, Workspace, WorktreeCheckout } from "@citadel/contracts";
import type { SqliteStore } from "@citadel/db";
import type { GitHubProviderStateService } from "./github-provider-state.js";
import { checkoutVcCacheKey } from "./provider-cache.js";

const TERMINAL_WORK_STATUSES = new Set<AgentSession["status"]>(["idle", "waiting_for_input", "stopped"]);
const DEFAULT_DEBOUNCE_MS = 2 * 60_000;

export type AgentStatusTransition = {
  session: AgentSession;
  previousStatus: AgentSession["status"];
  nextStatus: AgentSession["status"];
};

export type CheckoutPrPrimer = (transition: AgentStatusTransition) => void;

export function createCheckoutPrPrimeOnAgentFinish(input: {
  store: Pick<SqliteStore, "findWorkspaceCheckout" | "listRepos" | "listWorkspaces">;
  github: Pick<GitHubProviderStateService, "fetchCheckoutVersionControl">;
  debounceMs?: number;
  now?: () => number;
  readHead?: (checkout: WorktreeCheckout) => string | null;
  onRefreshed?: (workspace: Workspace, checkout: WorktreeCheckout) => void;
  onError?: (error: unknown) => void;
}): CheckoutPrPrimer {
  const lastAttemptByCheckoutHead = new Map<string, number>();
  const inFlight = new Set<string>();
  const now = input.now ?? Date.now;
  const debounceMs = input.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  return (transition) => {
    if (!shouldPrimeCheckoutPr(transition)) return;
    const checkout = input.store.findWorkspaceCheckout(transition.session.checkoutId ?? "");
    if (!checkout || checkout.archivedAt) return;
    const workspace = input.store.listWorkspaces().find((candidate) => candidate.id === checkout.workspaceId);
    const repo = input.store.listRepos().find((candidate) => candidate.id === checkout.repoId);
    if (!workspace || !repo) return;
    const head = input.readHead?.(checkout) ?? readLocalHead(checkout.path) ?? checkout.intendedPr?.headSha ?? "";
    const attemptKey = `${checkout.id}:${head}`;
    const lastAttempt = lastAttemptByCheckoutHead.get(attemptKey) ?? 0;
    const nowMs = now();
    if (nowMs - lastAttempt < debounceMs) return;
    if (inFlight.has(attemptKey)) return;
    lastAttemptByCheckoutHead.set(attemptKey, nowMs);
    inFlight.add(attemptKey);
    void input.github
      .fetchCheckoutVersionControl(
        workspace,
        checkout,
        repo,
        checkoutVcCacheKey(workspace.id, checkout.id, checkout.updatedAt),
        { intent: "automatic", force: true, staleWhileRevalidate: true },
      )
      .then(() => input.onRefreshed?.(workspace, checkout))
      .catch((error) => input.onError?.(error))
      .finally(() => inFlight.delete(attemptKey));
  };
}

export function shouldPrimeCheckoutPr(input: AgentStatusTransition): boolean {
  if (input.previousStatus !== "running") return false;
  if (!TERMINAL_WORK_STATUSES.has(input.nextStatus)) return false;
  if (input.session.kind !== "agent") return false;
  if (!input.session.checkoutId) return false;
  return input.session.targetType === undefined || input.session.targetType === "worktree_checkout";
}

function readLocalHead(checkoutPath: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: checkoutPath,
      timeout: 3000,
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
  } catch {
    return null;
  }
}
