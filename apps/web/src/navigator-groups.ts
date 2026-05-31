import type { Namespace, Operation, Repo, Workspace, WorkspaceSession } from "@citadel/contracts";
import { readinessForWorkspace } from "./cockpit-readiness.js";
import { formatLabel } from "./labels.js";
import type { GroupKey } from "./modals.js";

export const SECTION_ORDER = ["blocked", "needs-review", "working", "dirty", "idle", "done"];

// Subset of GroupKey that actually participates in the bucket tree. "none" is
// the navigator's flat-list mode and never reaches buildGroupTree.
export type GroupableKey = Exclude<GroupKey, "none">;

export type WorkspaceEntry = { workspace: Workspace; sessions: WorkspaceSession[] };

export type GroupNode =
  | { kind: "group"; id: string; path: string; label: string; count: number; children: GroupNode[] }
  | {
      kind: "leaf";
      id: string;
      path: string;
      label: string;
      count: number;
      workspaces: WorkspaceEntry[];
      // Present when the leaf is keyed by namespace. `null` is the explicit
      // "no namespace assigned" bucket (Uncategorized). Absent on other leaves
      // (repo, status) so DnD only attaches where it makes sense.
      namespaceId?: string | null;
    };

type EnrichedWorkspace = WorkspaceEntry & {
  repo: Repo | undefined;
  section: string;
  namespace: Namespace | null;
};

const UNCATEGORIZED_KEY = "__uncategorized__";

function rawBucketKey(entry: EnrichedWorkspace, field: GroupableKey): string {
  if (field === "repo") return entry.repo?.name ?? "Unknown repo";
  if (field === "namespace") return entry.namespace ? entry.namespace.id : UNCATEGORIZED_KEY;
  return entry.section ?? "idle";
}

function bucketLabel(rawKey: string, field: GroupableKey, namespaces: Namespace[]): string {
  if (field === "repo") return rawKey;
  if (field === "namespace") {
    if (rawKey === UNCATEGORIZED_KEY) return "Uncategorized";
    return namespaces.find((entry) => entry.id === rawKey)?.name ?? rawKey;
  }
  return formatLabel(rawKey);
}

function compareKeys(a: string, b: string, field: GroupableKey, namespaces: Namespace[]): number {
  if (field === "status") {
    const ai = SECTION_ORDER.indexOf(a);
    const bi = SECTION_ORDER.indexOf(b);
    return (ai < 0 ? SECTION_ORDER.length : ai) - (bi < 0 ? SECTION_ORDER.length : bi);
  }
  if (field === "namespace") {
    // Float Uncategorized to the bottom; sort named namespaces by display name.
    if (a === UNCATEGORIZED_KEY) return 1;
    if (b === UNCATEGORIZED_KEY) return -1;
    const an = namespaces.find((entry) => entry.id === a)?.name ?? a;
    const bn = namespaces.find((entry) => entry.id === b)?.name ?? b;
    return an.localeCompare(bn);
  }
  return a.localeCompare(b);
}

// Status sections are derived from data that ships in /api/state (sessions,
// operations, workspace.lifecycle/dirty) — never from the per-workspace
// /cockpit-summary readiness. Mixing the two made the active workspace's nav
// card jump between sections each time the summary refetched.
//
// `namespaces` is optional: only consulted when "namespace" appears in the
// grouping. Pass it whenever the caller might use namespace mode.
export function buildGroupTree(
  workspaces: Workspace[],
  repos: Repo[],
  sessions: WorkspaceSession[],
  operations: Operation[],
  grouping: GroupableKey[],
  namespaces: Namespace[] = [],
): GroupNode[] {
  if (!grouping.length) return [];

  const enriched: EnrichedWorkspace[] = workspaces.map((workspace) => {
    const workspaceSessions = sessions.filter((session) => session.workspaceId === workspace.id);
    const workspaceOps = operations.filter((operation) => operation.workspaceId === workspace.id);
    const attention = readinessForWorkspace(workspace, {
      sessions: workspaceSessions,
      operations: workspaceOps,
    });
    const repo = repos.find((entry) => entry.id === workspace.repoId);
    const namespace = workspace.namespaceId
      ? (namespaces.find((entry) => entry.id === workspace.namespaceId) ?? null)
      : null;
    return { workspace, sessions: workspaceSessions, repo, namespace, section: attention.section };
  });

  const build = (entries: EnrichedWorkspace[], levels: GroupableKey[], parentPath: string): GroupNode[] => {
    if (!levels.length) return [];
    const head = levels[0] as GroupableKey;
    const rest = levels.slice(1);
    const buckets = new Map<string, EnrichedWorkspace[]>();
    for (const entry of entries) {
      const key = rawBucketKey(entry, head);
      const list = buckets.get(key) ?? [];
      list.push(entry);
      buckets.set(key, list);
    }
    // Seed an Uncategorized bucket for namespace leaves even when empty, so
    // the user always has a target to drag onto when grouping by namespace.
    if (head === "namespace" && !buckets.has(UNCATEGORIZED_KEY)) {
      buckets.set(UNCATEGORIZED_KEY, []);
    }
    const ordered = Array.from(buckets.keys()).sort((a, b) => compareKeys(a, b, head, namespaces));
    const nodes: GroupNode[] = [];
    for (const rawKey of ordered) {
      const items = buckets.get(rawKey);
      if (!items) continue;
      const segment = `${head}=${rawKey}`;
      const nodePath = parentPath ? `${parentPath}/${segment}` : segment;
      const label = bucketLabel(rawKey, head, namespaces);
      if (rest.length === 0) {
        const leaf: GroupNode = {
          kind: "leaf",
          id: nodePath,
          path: nodePath,
          label,
          count: items.length,
          workspaces: items.map(({ workspace, sessions: ws }) => ({ workspace, sessions: ws })),
        };
        if (head === "namespace") {
          (leaf as { namespaceId?: string | null }).namespaceId = rawKey === UNCATEGORIZED_KEY ? null : rawKey;
        }
        nodes.push(leaf);
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
