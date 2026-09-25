import { execFileSync } from "node:child_process";
import type { AgentSession, Repo, Workspace, WorktreeCheckout } from "@citadel/contracts";
import type { SqliteStore } from "@citadel/db";
import type { GitHubProviderStateService } from "./github-provider-state.js";
import { checkoutVcCacheKey, vcCacheKey } from "./provider-cache.js";

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
  github: Pick<GitHubProviderStateService, "fetchCheckoutVersionControl" | "fetchVersionControl">;
  debounceMs?: number;
  now?: () => number;
  readHead?: (target: Workspace | WorktreeCheckout) => string | null;
  onRefreshed?: (workspace: Workspace, checkout: WorktreeCheckout | null) => void;
  onError?: (error: unknown) => void;
}): CheckoutPrPrimer {
  const lastAttemptByTargetHead = new Map<string, number>();
  const inFlight = new Set<string>();
  const now = input.now ?? Date.now;
  const debounceMs = input.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  return (transition) => {
    if (!shouldPrimeCheckoutPr(transition)) return;
    const target = resolvePrimeTarget(input.store, transition.session);
    if (!target) return;
    const head =
      input.readHead?.(target.headTarget) ?? readLocalHead(target.headTarget.path) ?? target.fallbackHead ?? "";
    const attemptKey = `${target.id}:${head}`;
    const lastAttempt = lastAttemptByTargetHead.get(attemptKey) ?? 0;
    const nowMs = now();
    if (nowMs - lastAttempt < debounceMs) return;
    if (inFlight.has(attemptKey)) return;
    lastAttemptByTargetHead.set(attemptKey, nowMs);
    inFlight.add(attemptKey);
    const refresh =
      target.kind === "checkout"
        ? input.github.fetchCheckoutVersionControl(
            target.workspace,
            target.checkout,
            target.repo,
            checkoutVcCacheKey(target.workspace.id, target.checkout.id, target.checkout.updatedAt),
            { intent: "automatic", force: true, staleWhileRevalidate: true },
          )
        : input.github.fetchVersionControl(
            target.workspace,
            target.repo,
            vcCacheKey(target.workspace.id, target.workspace.updatedAt),
            { intent: "automatic", force: true, staleWhileRevalidate: true },
          );
    void refresh
      .then(() => input.onRefreshed?.(target.workspace, target.kind === "checkout" ? target.checkout : null))
      .catch((error) => input.onError?.(error))
      .finally(() => inFlight.delete(attemptKey));
  };
}

export function shouldPrimeCheckoutPr(input: AgentStatusTransition): boolean {
  if (input.previousStatus !== "running") return false;
  if (!TERMINAL_WORK_STATUSES.has(input.nextStatus)) return false;
  if (input.session.kind !== "agent") return false;
  return (
    input.session.targetType === undefined ||
    input.session.targetType === "worktree_checkout" ||
    input.session.targetType === "workspace_home"
  );
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

type PrimeTarget =
  | {
      kind: "checkout";
      id: string;
      workspace: Workspace;
      checkout: WorktreeCheckout;
      repo: Repo;
      headTarget: WorktreeCheckout;
      fallbackHead: string | null | undefined;
    }
  | {
      kind: "workspace";
      id: string;
      workspace: Workspace;
      repo: Repo;
      headTarget: Workspace;
      fallbackHead: string | null | undefined;
    };

function resolvePrimeTarget(
  store: Pick<SqliteStore, "findWorkspaceCheckout" | "listRepos" | "listWorkspaces">,
  session: AgentSession,
): PrimeTarget | null {
  if (session.checkoutId) {
    const checkout = store.findWorkspaceCheckout(session.checkoutId);
    if (!checkout || checkout.archivedAt) return null;
    const workspace = store.listWorkspaces().find((candidate) => candidate.id === checkout.workspaceId);
    const repo = store.listRepos().find((candidate) => candidate.id === checkout.repoId);
    if (!workspace || !repo) return null;
    return {
      kind: "checkout",
      id: `checkout:${checkout.id}`,
      workspace,
      checkout,
      repo,
      headTarget: checkout,
      fallbackHead: checkout.intendedPr?.headSha,
    };
  }

  const workspace = store.listWorkspaces().find((candidate) => candidate.id === session.workspaceId);
  if (!workspace || workspace.archivedAt || !workspace.repoId) return null;
  const repo = store.listRepos().find((candidate) => candidate.id === workspace.repoId);
  if (!repo) return null;
  return {
    kind: "workspace",
    id: `workspace:${workspace.id}`,
    workspace,
    repo,
    headTarget: workspace,
    fallbackHead: null,
  };
}
