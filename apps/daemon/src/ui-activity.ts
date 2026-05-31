const DEFAULT_FOCUSED_WINDOW_STALE_MS = 2 * 60 * 1000;

type PageActivity = {
  focused: boolean;
  visible: boolean;
  updatedAt: number;
};

export type UiActivityTracker = {
  recordClientEvent: (body: Record<string, unknown>) => void;
  hasFocusedWindow: () => boolean;
};

export function createUiActivityTracker(
  options: { now?: () => number; staleAfterMs?: number } = {},
): UiActivityTracker {
  const now = options.now ?? (() => Date.now());
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_FOCUSED_WINDOW_STALE_MS;
  const pages = new Map<string, PageActivity>();

  function prune(): void {
    const cutoff = now() - staleAfterMs;
    for (const [pageId, activity] of pages) {
      if (activity.updatedAt < cutoff) pages.delete(pageId);
    }
  }

  return {
    recordClientEvent(body) {
      const pageId = typeof body.pageId === "string" && body.pageId.length > 0 ? body.pageId : null;
      if (!pageId) return;
      const event = typeof body.event === "string" ? body.event : "";
      if (event === "page.pagehide") {
        pages.delete(pageId);
        return;
      }

      const visible = body.visibility === "visible";
      const focused = body.focused === true && visible;
      pages.set(pageId, { focused, visible, updatedAt: now() });
      prune();
    },
    hasFocusedWindow() {
      prune();
      for (const activity of pages.values()) {
        if (activity.visible && activity.focused) return true;
      }
      return false;
    },
  };
}
