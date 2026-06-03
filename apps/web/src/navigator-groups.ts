import type { Namespace, Operation, Repo, Workspace, WorkspaceSession, WorktreeCheckout } from "@citadel/contracts";
import { readinessForWorkspace } from "./cockpit-readiness.js";
import { formatLabel } from "./labels.js";

export const SECTION_ORDER = ["blocked", "needs-review", "working", "dirty", "idle", "done"];

export type GroupKey = "workspace" | "repo" | "status" | "namespace";
export type NavigatorGrouping = GroupKey[];

// Subset of GroupKey that actually participates in the bucket tree. "workspace"
// is rendered as the workspace-root list and never reaches buildGroupTree.
export type GroupableKey = Exclude<GroupKey, "workspace">;

export function normalizeNavigatorGrouping(value: unknown): NavigatorGrouping {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const out: NavigatorGrouping = [];
  for (const key of raw) {
    if (key !== "workspace" && key !== "repo" && key !== "status" && key !== "namespace") continue;
    if (!out.includes(key)) out.push(key);
  }
  if (!out.length) return ["workspace"];
  if (out.includes("namespace") && (out.includes("repo") || out.includes("status"))) {
    return out.filter((key) => key !== "workspace" && key !== "namespace");
  }
  if (out.includes("workspace") && (out.includes("repo") || out.includes("status"))) {
    return out.filter((key) => key !== "workspace");
  }
  if (out.includes("namespace")) {
    return [...out.filter((key) => key !== "workspace"), "workspace"];
  }
  return out;
}

// Translate the user-facing grouping sequence into the level sequence
// buildGroupTree consumes. "workspace" is the leaf/root workspace card mode,
// so combining it with namespace means "namespace groups containing workspace
// rows"; combining it with repo/status is normalized away above.
export function treeGroupingFor(grouping: NavigatorGrouping | GroupKey | "none"): GroupableKey[] {
  return normalizeNavigatorGrouping(grouping).filter((key): key is GroupableKey => key !== "workspace");
}

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
  checkouts: WorktreeCheckout[] = [],
): GroupNode[] {
  if (!grouping.length) return [];

  const groupByRepo = grouping.includes("repo");
  const enriched: EnrichedWorkspace[] = workspaces.flatMap((workspace) => {
    const workspaceSessions = sessions.filter((session) => session.workspaceId === workspace.id);
    const workspaceOps = operations.filter((operation) => operation.workspaceId === workspace.id);
    const attention = readinessForWorkspace(workspace, {
      sessions: workspaceSessions,
      operations: workspaceOps,
    });
    const namespace = workspace.namespaceId
      ? (namespaces.find((entry) => entry.id === workspace.namespaceId) ?? null)
      : null;
    const repoIds = groupByRepo ? repoIdsForWorkspace(workspace, checkouts) : [workspace.repoId];
    return repoIds.map((repoId) => ({
      workspace,
      sessions: workspaceSessions,
      repo: repos.find((entry) => entry.id === repoId),
      namespace,
      section: attention.section,
    }));
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

function repoIdsForWorkspace(workspace: Workspace, checkouts: WorktreeCheckout[]): Array<string | null> {
  if (workspace.repoId) return [workspace.repoId];
  const liveRepoIds = new Set<string>();
  for (const checkout of checkouts) {
    if (checkout.workspaceId === workspace.id && !checkout.archivedAt) liveRepoIds.add(checkout.repoId);
  }
  return liveRepoIds.size ? Array.from(liveRepoIds) : [];
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

// Depth-first flatten of the rendered tree to a list of workspace IDs in
// in-tree visible order. Collapse state is intentionally ignored — this is
// the index space cockpit-side nav shortcuts (Ctrl+1..9) map onto, and the
// caller auto-expands the relevant group via expandGroupPath so the
// selected workspace becomes visible.
//
// When the tree is empty (grouping = "none" — buildGroupTree returns []),
// the cockpit falls back to walking `workspaces` in input order (see
// the inline fallback at `apps/web/src/cockpit.tsx`'s flatWorkspaceIds memo).
export function flattenWorkspaceOrder(nodes: GroupNode[]): string[] {
  const out: string[] = [];
  const walk = (list: GroupNode[]) => {
    for (const node of list) {
      if (node.kind === "leaf") {
        for (const entry of node.workspaces) out.push(entry.workspace.id);
      } else {
        walk(node.children);
      }
    }
  };
  walk(nodes);
  return out;
}

// Find the group node path that contains the given workspace, deepest match
// first. Returns null when the workspace is not present in the tree (or the
// tree is empty / grouping = "none", in which case no group expansion is
// needed). Used by cockpit nav shortcuts to auto-expand the enclosing group.
export function findGroupPathForWorkspace(nodes: GroupNode[], workspaceId: string): string | null {
  const walk = (list: GroupNode[]): string | null => {
    for (const node of list) {
      if (node.kind === "leaf") {
        if (node.workspaces.some((entry) => entry.workspace.id === workspaceId)) return node.path;
      } else {
        const inner = walk(node.children);
        if (inner !== null) return inner;
      }
    }
    return null;
  };
  return walk(nodes);
}
