import type {
  ActivityEvent,
  AgentSession,
  HookAction,
  HookLink,
  Repo,
  Workspace,
  WorktreeCheckout,
} from "@citadel/contracts";

export function serializeWorkspaceResource(input: {
  repos: Repo[];
  workspaces: Workspace[];
  sessions: AgentSession[];
  checkouts?: WorktreeCheckout[];
}) {
  return {
    repos: input.repos,
    workspaces: input.workspaces,
    checkouts: input.checkouts ?? [],
    sessions: input.sessions.map((session) => ({
      id: session.id,
      workspaceId: session.workspaceId,
      runtimeId: session.runtimeId,
      status: session.status,
      tmuxSessionName: session.tmuxSessionName,
    })),
  };
}

export function listWorkspaceLinks(activity: ActivityEvent[], workspaceId: unknown) {
  const events =
    typeof workspaceId === "string" ? activity.filter((event) => event.workspaceId === workspaceId) : activity;
  const links: Array<HookLink & { workspaceId: string; eventId: string }> = [];
  const actions: Array<HookAction & { workspaceId: string; eventId: string }> = [];
  for (const event of events) {
    if (!event.workspaceId || !event.hookOutput) continue;
    links.push(
      ...event.hookOutput.links.map((link) => ({ ...link, workspaceId: event.workspaceId ?? "", eventId: event.id })),
    );
    actions.push(
      ...event.hookOutput.actions.map((action) => ({
        ...action,
        workspaceId: event.workspaceId ?? "",
        eventId: event.id,
      })),
    );
  }
  return { links, actions };
}
