// Cross-component bridge for Navigator state (grouping mode + collapsed paths).
// Navigator owns the React state authoritatively, but Cockpit's nav
// shortcuts (Ctrl+N) need to be able to uncollapse a group from outside the
// component. The bridge stores the truth in localStorage (same key Navigator
// reads on mount) AND broadcasts an in-tab custom event so Navigator can
// react immediately without waiting for a remount.

export const COLLAPSE_STORAGE_KEY = "citadel.navigator-group-collapsed";
export const GROUP_STORAGE_KEY = "citadel.navigator-group";
export const NAVIGATOR_COLLAPSE_EVENT = "citadel:navigator-collapse-changed";
export const NAVIGATOR_GROUPING_EVENT = "citadel:navigator-grouping-changed";

type NavigatorGrouping = "workspace" | "repo" | "status" | "namespace" | "none";

export function readNavigatorGrouping(): NavigatorGrouping {
  if (typeof window === "undefined") return "workspace";
  try {
    const raw = window.localStorage.getItem(GROUP_STORAGE_KEY) ?? "";
    if (raw === "workspace" || raw === "repo" || raw === "status" || raw === "namespace" || raw === "none") return raw;
  } catch {
    // fall through
  }
  return "workspace";
}

// In-tab broadcast for grouping changes. The browser's native `storage` event
// fires only across tabs, so a single-tab grouping switch (the common case)
// would otherwise leave cockpit-side consumers stale. Navigator writes this
// event whenever the user picks a new grouping mode.
export function publishNavigatorGroupingChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(NAVIGATOR_GROUPING_EVENT));
}

export function subscribeToGroupingChanges(handler: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = () => handler();
  window.addEventListener(NAVIGATOR_GROUPING_EVENT, listener);
  return () => window.removeEventListener(NAVIGATOR_GROUPING_EVENT, listener);
}

type CollapsedMap = Record<string, boolean>;

export function readCollapsedMap(): CollapsedMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(COLLAPSE_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as CollapsedMap;
    }
  } catch {
    // fall through
  }
  return {};
}

function writeCollapsedMap(map: CollapsedMap): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify(map));
  window.dispatchEvent(new CustomEvent(NAVIGATOR_COLLAPSE_EVENT));
}

// Uncollapse the given path AND every ancestor path along the chain. Paths
// in Navigator are slash-delimited (`repo=alpha/status=idle`), so we strip
// trailing segments to derive ancestors. No-op when nothing changes.
export function expandGroupPath(path: string): void {
  const current = readCollapsedMap();
  const ancestors = pathAncestors(path);
  let changed = false;
  const next: CollapsedMap = { ...current };
  for (const candidate of ancestors) {
    if (next[candidate]) {
      delete next[candidate];
      changed = true;
    }
  }
  if (!changed) return;
  writeCollapsedMap(next);
}

function pathAncestors(path: string): string[] {
  const parts = path.split("/");
  const out: string[] = [];
  for (let i = 1; i <= parts.length; i += 1) {
    out.push(parts.slice(0, i).join("/"));
  }
  return out;
}

export function subscribeToCollapseChanges(handler: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = () => handler();
  window.addEventListener(NAVIGATOR_COLLAPSE_EVENT, listener);
  return () => window.removeEventListener(NAVIGATOR_COLLAPSE_EVENT, listener);
}
