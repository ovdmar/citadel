import type { AgentRuntime, RoleTemplate, TerminalProfile, Workspace } from "@citadel/contracts";

export type StageStructuredAction = {
  id: string;
  label: string;
  toolName:
    | "launch_pm_agent"
    | "launch_architect_agent"
    | "launch_implementation_agent"
    | "launch_prototype_agent"
    | "start_workspace_manager";
  arguments: Record<string, unknown>;
};

export type StageDirectRoleAction = {
  id: string;
  label: string;
  template: RoleTemplate;
};

export type StageLaunchEntry =
  | {
      type: "structured";
      id: string;
      group: "specialized";
      label: string;
      icon: "agent";
      title: string;
      detail: string | null;
      disabled: boolean;
      action: StageStructuredAction;
    }
  | {
      type: "direct-role";
      id: string;
      group: "specialized";
      label: string;
      icon: "agent";
      title: string;
      detail: string | null;
      disabled: boolean;
      action: StageDirectRoleAction;
    }
  | {
      type: "terminal";
      id: "terminal";
      group: "freestyle";
      label: string;
      icon: "terminal";
      title: string;
      detail: string | null;
      disabled: boolean;
    }
  | {
      type: "runtime";
      id: string;
      group: "freestyle";
      label: string;
      icon: "agent";
      title: string;
      detail: string;
      disabled: boolean;
      runtime: AgentRuntime;
    };

export type StageLaunchEntryGroup = {
  id: "specialized" | "freestyle";
  label: "Specialized" | "Freestyle";
  entries: StageLaunchEntry[];
};

export const WORKSPACE_SESSION_CAP = 20;

export function structuredStageActions(input: {
  workspace: Workspace;
  targetType: "workspace_home" | "worktree_checkout";
  checkoutId: string | null;
}): StageStructuredAction[] {
  if (input.workspace.mode !== "structured") return [];
  if (input.targetType === "workspace_home") {
    return [
      {
        id: "pm",
        label: "PM",
        toolName: "launch_pm_agent",
        arguments: { workspaceId: input.workspace.id },
      },
      {
        id: "architect",
        label: "Architect",
        toolName: "launch_architect_agent",
        arguments: { workspaceId: input.workspace.id, planApprovalMode: "manual" },
      },
      {
        id: "manager",
        label: "Manager",
        toolName: "start_workspace_manager",
        arguments: { workspaceId: input.workspace.id },
      },
    ];
  }
  if (!input.checkoutId) return [];
  return [
    {
      id: "implementation",
      label: "Implementation",
      toolName: "launch_implementation_agent",
      arguments: { checkoutId: input.checkoutId },
    },
    {
      id: "prototype",
      label: "Prototype",
      toolName: "launch_prototype_agent",
      arguments: { checkoutId: input.checkoutId },
    },
  ];
}

export function freestyleStageActions(input: {
  workspace: Workspace;
  templates: RoleTemplate[];
}): StageDirectRoleAction[] {
  if (input.workspace.mode === "structured") return [];
  return ["pm", "prototype"].flatMap((role) => {
    const template = input.templates.find((entry) => entry.role === role);
    return template ? [{ id: role, label: template.displayName, template }] : [];
  });
}

export function buildStageLaunchEntryGroups(input: {
  structuredActions: StageStructuredAction[];
  directRoleActions: StageDirectRoleAction[];
  terminal: TerminalProfile;
  runtimes: AgentRuntime[];
  addDisabled: boolean;
  atSessionCap: boolean;
  sessionCap?: number;
}): StageLaunchEntryGroup[] {
  const sessionCap = input.sessionCap ?? WORKSPACE_SESSION_CAP;
  const capTitle = `Cap reached (${sessionCap}). Close a session first.`;
  const specializedEntries: StageLaunchEntry[] = [
    ...input.structuredActions.map((action): StageLaunchEntry => {
      const title = input.atSessionCap ? capTitle : action.label;
      return {
        type: "structured",
        id: `structured:${action.id}`,
        group: "specialized",
        label: action.label,
        icon: "agent",
        title,
        detail: null,
        disabled: input.addDisabled,
        action,
      };
    }),
    ...input.directRoleActions.map((action): StageLaunchEntry => {
      const title = input.atSessionCap ? capTitle : action.label;
      return {
        type: "direct-role",
        id: `direct:${action.id}`,
        group: "specialized",
        label: action.label,
        icon: "agent",
        title,
        detail: null,
        disabled: input.addDisabled,
        action,
      };
    }),
  ];
  const freestyleEntries: StageLaunchEntry[] = [
    {
      type: "terminal",
      id: "terminal",
      group: "freestyle",
      label: input.terminal.displayName,
      icon: "terminal",
      title: input.atSessionCap ? capTitle : "Start a terminal in this workspace",
      detail: null,
      disabled: input.addDisabled,
    },
    ...input.runtimes.map((runtime): StageLaunchEntry => {
      const runtimeTitle = input.atSessionCap
        ? capTitle
        : runtime.health === "healthy"
          ? `Start ${runtime.displayName}`
          : `${runtime.displayName} is ${runtime.health}${runtime.healthReason ? ` · ${runtime.healthReason}` : ""}`;
      return {
        type: "runtime",
        id: `runtime:${runtime.id}`,
        group: "freestyle",
        label: runtime.displayName,
        icon: "agent",
        title: runtimeTitle,
        detail: runtime.health,
        disabled: runtime.health !== "healthy" || input.addDisabled,
        runtime,
      };
    }),
  ];
  return [
    specializedEntries.length ? { id: "specialized", label: "Specialized", entries: specializedEntries } : null,
    { id: "freestyle", label: "Freestyle", entries: freestyleEntries },
  ].filter((group): group is StageLaunchEntryGroup => Boolean(group));
}
