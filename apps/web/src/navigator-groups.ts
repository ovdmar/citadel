import type { AgentSession, Operation, Repo, Workspace, WorkspaceCockpitSummary } from "@citadel/contracts";
import { readinessForWorkspace, readinessSection } from "./cockpit-readiness.js";
import { formatLabel } from "./labels.js";
import type { GroupKey } from "./modals.js";

export const SECTION_ORDER = ["blocked", "needs-review", "working", "dirty", "idle", "done"];

export type WorkspaceEntry = { workspace: Workspace; sessions: AgentSession[] };

export type GroupNode =
  | { kind: "group"; id: string; path: string; label: string; count: number; children: GroupNode[] }
  | { kind: "leaf"; id: string; path: string; label: string; count: number; workspaces: WorkspaceEntry[] };

type EnrichedWorkspace = WorkspaceEntry & { repo: Repo | undefined; section: string };

function rawBucketKey(entry: EnrichedWorkspace, field: GroupKey): string {
  return field === "repo" ? (entry.repo?.name ?? "Unknown repo") : (entry.section ?? "idle");
}

function bucketLabel(rawKey: string, field: GroupKey): string {
  return field === "repo" ? rawKey : formatLabel(rawKey);
}

function compareKeys(a: string, b: string, field: GroupKey): number {
  if (field === "status") {
    const ai = SECTION_ORDER.indexOf(a);
    const bi = SECTION_ORDER.indexOf(b);
    return (ai < 0 ? SECTION_ORDER.length : ai) - (bi < 0 ? SECTION_ORDER.length : bi);
  }
  return a.localeCompare(b);
}

export function buildGroupTree(
  workspaces: Workspace[],
  repos: Repo[],
  sessions: AgentSession[],
  operations: Operation[],
  activeSummary: WorkspaceCockpitSummary | undefined,
  grouping: GroupKey[],
): GroupNode[] {
  if (!grouping.length) return [];

  const enriched: EnrichedWorkspace[] = workspaces.map((workspace) => {
    const workspaceSessions = sessions.filter((session) => session.workspaceId === workspace.id);
    const workspaceOps = operations.filter((operation) => operation.workspaceId === workspace.id);
    const summary = workspace.id === activeSummary?.workspaceId ? activeSummary : undefined;
    const attention = readinessForWorkspace(workspace, {
      sessions: workspaceSessions,
      operations: workspaceOps,
      summary,
    });
    const section = summary ? readinessSection(summary.readiness.state) : attention.section;
    const repo = repos.find((entry) => entry.id === workspace.repoId);
    return { workspace, sessions: workspaceSessions, repo, section };
  });

  const build = (entries: EnrichedWorkspace[], levels: GroupKey[], parentPath: string): GroupNode[] => {
    if (!entries.length || !levels.length) return [];
    const head = levels[0] as GroupKey;
    const rest = levels.slice(1);
    const buckets = new Map<string, EnrichedWorkspace[]>();
    for (const entry of entries) {
      const key = rawBucketKey(entry, head);
      const list = buckets.get(key) ?? [];
      list.push(entry);
      buckets.set(key, list);
    }
    const ordered = Array.from(buckets.keys()).sort((a, b) => compareKeys(a, b, head));
    const nodes: GroupNode[] = [];
    for (const rawKey of ordered) {
      const items = buckets.get(rawKey);
      if (!items?.length) continue;
      const segment = `${head}=${rawKey}`;
      const nodePath = parentPath ? `${parentPath}/${segment}` : segment;
      const label = bucketLabel(rawKey, head);
      if (rest.length === 0) {
        nodes.push({
          kind: "leaf",
          id: nodePath,
          path: nodePath,
          label,
          count: items.length,
          workspaces: items.map(({ workspace, sessions: ws }) => ({ workspace, sessions: ws })),
        });
      } else {
        const children = build(items, rest, nodePath);
        if (!children.length) continue;
        nodes.push({
          kind: "group",
          id: nodePath,
          path: nodePath,
          label,
          count: items.length,
          children,
        });
      }
    }
    return nodes;
  };

  return build(enriched, grouping, "");
}

export function collectGroupPaths(nodes: GroupNode[]): Set<string> {
  const paths = new Set<string>();
  const walk = (list: GroupNode[]) => {
    for (const node of list) {
      paths.add(node.path);
      if (node.kind === "group") walk(node.children);
    }
  };
  walk(nodes);
  return paths;
}
