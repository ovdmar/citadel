// Client-side workspace reordering — localStorage-backed, no server sync.
// Stored as Record<groupPath, workspaceId[]>. The group path is the rendered
// nav-tree path (e.g. `repo/<repoId>`, `status/running`, or the literal
// `__flat` when grouping is disabled), so switching group-by selects a
// different ordering bucket and doesn't bleed cross-mode.

export const NAV_ORDER_STORAGE = "citadel.navigator-order";

// dataTransfer mime types. The source group path is encoded into the mime
// type suffix because `dataTransfer.getData` is not reliably readable during
// `dragover`, where we need to reject cross-group drops. Browsers lowercase
// drag MIME types, so the path is hex-encoded first.
const REORDER_MIME_PREFIX = "application/x-citadel-workspace-reorder";

export function encodeReorderMimeType(groupPath: string): string {
  return `${REORDER_MIME_PREFIX}+${encodeGroupPath(groupPath)}`;
}

export function parseReorderMimeType(mime: string): string | null {
  if (!mime.startsWith(`${REORDER_MIME_PREFIX}+`)) return null;
  return decodeGroupPath(mime.slice(REORDER_MIME_PREFIX.length + 1));
}

export function findReorderMimeType(types: readonly string[]): string | null {
  for (const type of types) if (type.startsWith(`${REORDER_MIME_PREFIX}+`)) return type;
  return null;
}

function encodeGroupPath(value: string): string {
  let output = "";
  const escaped = encodeURIComponent(value);
  for (let i = 0; i < escaped.length; i++) {
    output += escaped.charCodeAt(i).toString(16).padStart(2, "0");
  }
  return output;
}

function decodeGroupPath(value: string): string | null {
  if (!value || value.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(value)) return null;
  let escaped = "";
  for (let i = 0; i < value.length; i += 2) {
    escaped += String.fromCharCode(Number.parseInt(value.slice(i, i + 2), 16));
  }
  try {
    return decodeURIComponent(escaped);
  } catch {
    return null;
  }
}

// Apply a per-group user-provided order to a list of workspace entries.
// Entries whose id appears in `idOrder` come first in the given sequence;
// remaining entries follow in their original (default-sort) order. Stale
// ids (workspace removed since localStorage was written) are ignored.
export function applyLocalOrder<T extends { workspace: { id: string } }>(
  entries: readonly T[],
  idOrder: readonly string[] | undefined,
): T[] {
  if (!idOrder || idOrder.length === 0) return entries.slice();
  const byId = new Map<string, T>();
  for (const entry of entries) byId.set(entry.workspace.id, entry);
  const head: T[] = [];
  const seen = new Set<string>();
  for (const id of idOrder) {
    const entry = byId.get(id);
    if (entry && !seen.has(id)) {
      head.push(entry);
      seen.add(id);
    }
  }
  const tail = entries.filter((entry) => !seen.has(entry.workspace.id));
  return [...head, ...tail];
}

export function loadOrder(): Record<string, string[]> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(NAV_ORDER_STORAGE);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (Array.isArray(value) && value.every((id) => typeof id === "string")) {
        out[key] = value;
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function saveOrder(order: Record<string, string[]>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(NAV_ORDER_STORAGE, JSON.stringify(order));
  } catch {
    // localStorage full or denied — fail silent. User keeps default sort.
  }
}

// Remove ids that no longer correspond to live workspaces. Mirrors the
// collapsed-pruning effect in navigator.tsx so localStorage doesn't
// accumulate orphans across workspace deletions.
export function pruneOrder(
  order: Record<string, string[]>,
  liveWorkspaceIds: ReadonlySet<string>,
): Record<string, string[]> {
  const next: Record<string, string[]> = {};
  let changed = false;
  for (const [key, ids] of Object.entries(order)) {
    const filtered = ids.filter((id) => liveWorkspaceIds.has(id));
    if (filtered.length !== ids.length) changed = true;
    if (filtered.length > 0) next[key] = filtered;
    else changed = true;
  }
  return changed ? next : order;
}

// Splice `draggedId` into `currentOrder` so it lands at `targetIndex`.
// targetIndex is computed relative to the visible-rendered list (after
// applyLocalOrder), so the caller should pass the post-sort index, not the
// raw position in the default-sorted array. We rewrite the localStorage
// entry to capture the full visible-order so reload reproduces the exact
// arrangement the user just made.
export function spliceIntoOrder(visibleIds: readonly string[], draggedId: string, targetIndex: number): string[] {
  const without = visibleIds.filter((id) => id !== draggedId);
  const clamped = Math.max(0, Math.min(targetIndex, without.length));
  return [...without.slice(0, clamped), draggedId, ...without.slice(clamped)];
}
