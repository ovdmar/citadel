import type { AgentRuntime, Workspace, WorkspaceSession } from "@citadel/contracts";
import type { GroupNode } from "./navigator-groups.js";
import { findGroupPathForWorkspace } from "./navigator-groups.js";
import { defaultAgentRuntimeId } from "./runtime-defaults.js";
import type { ShortcutMatch } from "./shortcuts.js";

// Pure resolver that maps a matched shortcut + cockpit state to an intent.
// The cockpit useEffect maps each intent to a side effect (mutation, state
// update, focus change). Keeping resolution pure means we can truth-table
// every cmd+t / cmd+e / nav case without spinning up React.

type ShortcutAction =
  | { type: "toggle-command-palette" }
  | { type: "close-command-palette" }
  | { type: "nav-workspace"; workspaceId: string; expandGroupPath: string | null }
  | { type: "nav-session"; workspaceId: string; sessionId: string }
  | { type: "spawn-terminal"; workspaceId: string }
  | { type: "spawn-agent"; workspaceId: string; runtimeId: string; displayName: string }
  | { type: "spawn-agent-no-runtime" }
  | { type: "noop" };

export type ShortcutDeps = {
  flatWorkspaceIds: ReadonlyArray<string>;
  activeWorkspace: Workspace | null;
  activeWorkspaceSessions: ReadonlyArray<WorkspaceSession>;
  runtimes: ReadonlyArray<AgentRuntime>;
  navTree: ReadonlyArray<GroupNode>;
};

export function resolveShortcutAction(match: ShortcutMatch, deps: ShortcutDeps): ShortcutAction {
  switch (match.id) {
    case "command-palette":
      return { type: "toggle-command-palette" };
    case "close-overlay":
      return { type: "close-command-palette" };
    case "nav-workspace": {
      if (match.index === undefined) return { type: "noop" };
      const workspaceId = deps.flatWorkspaceIds[match.index];
      if (!workspaceId) return { type: "noop" };
      const expandGroupPath = deps.navTree.length
        ? findGroupPathForWorkspace(deps.navTree as GroupNode[], workspaceId)
        : null;
      return { type: "nav-workspace", workspaceId, expandGroupPath };
    }
    case "nav-session": {
      if (match.index === undefined || !deps.activeWorkspace) return { type: "noop" };
      const session = deps.activeWorkspaceSessions[match.index];
      if (!session) return { type: "noop" };
      return { type: "nav-session", workspaceId: deps.activeWorkspace.id, sessionId: session.id };
    }
    case "spawn-terminal": {
      if (!deps.activeWorkspace) return { type: "noop" };
      return { type: "spawn-terminal", workspaceId: deps.activeWorkspace.id };
    }
    case "spawn-agent": {
      if (!deps.activeWorkspace) return { type: "noop" };
      const runtimeId = defaultAgentRuntimeId(deps.runtimes);
      if (!runtimeId) return { type: "spawn-agent-no-runtime" };
      const runtime = deps.runtimes.find((entry) => entry.id === runtimeId);
      return {
        type: "spawn-agent",
        workspaceId: deps.activeWorkspace.id,
        runtimeId,
        displayName: runtime?.displayName ?? runtimeId,
      };
    }
  }
  return { type: "noop" };
}
