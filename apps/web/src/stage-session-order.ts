export const STAGE_SESSION_ORDER_STORAGE = "citadel.stage-session-order";

export function applySessionOrder<T extends { id: string }>(
  sessions: readonly T[],
  idOrder: readonly string[] | undefined,
  orderId: (session: T) => string = (session) => session.id,
): T[] {
  if (!idOrder || idOrder.length === 0) return sessions.slice();
  const byId = new Map<string, T>();
  for (const session of sessions) {
    byId.set(session.id, session);
    byId.set(orderId(session), session);
  }
  const head: T[] = [];
  const seen = new Set<string>();
  for (const id of idOrder) {
    const session = byId.get(id);
    if (session && !seen.has(session.id)) {
      head.push(session);
      seen.add(session.id);
    }
  }
  const tail = sessions.filter((session) => !seen.has(session.id));
  return [...head, ...tail];
}

export function spliceSessionOrder(visibleIds: readonly string[], draggedId: string, targetIndex: number): string[] {
  const without = visibleIds.filter((id) => id !== draggedId);
  const clamped = Math.max(0, Math.min(targetIndex, without.length));
  return [...without.slice(0, clamped), draggedId, ...without.slice(clamped)];
}

export function replaceSessionOrderId(idOrder: readonly string[] | undefined, fromId: string, toId: string): string[] {
  if (!idOrder || idOrder.length === 0) return [];
  const next = idOrder.map((id) => (id === fromId ? toId : id));
  return [...new Set(next)];
}

export function loadSessionOrder(): Record<string, string[]> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STAGE_SESSION_ORDER_STORAGE);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (Array.isArray(value) && value.every((id) => typeof id === "string")) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveSessionOrder(order: Record<string, string[]>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STAGE_SESSION_ORDER_STORAGE, JSON.stringify(order));
  } catch {
    // localStorage unavailable: keep default tab order for this session.
  }
}

export function pruneSessionOrder(
  order: Record<string, string[]>,
  liveSessionIds: ReadonlySet<string>,
): Record<string, string[]> {
  const next: Record<string, string[]> = {};
  let changed = false;
  for (const [workspaceId, ids] of Object.entries(order)) {
    const filtered = ids.filter((id) => liveSessionIds.has(id));
    if (filtered.length !== ids.length) changed = true;
    if (filtered.length > 0) next[workspaceId] = filtered;
    else changed = true;
  }
  return changed ? next : order;
}
