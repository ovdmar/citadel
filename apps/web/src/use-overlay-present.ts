import { useEffect } from "react";

// Global ref-count of currently-open top-layer overlays (command palette,
// modals, dialogs, etc.). The iframe shim reads this via
// window.parent.__citadelOverlayOpen to decide whether to forward an Escape
// keystroke to the cockpit — Escape inside xterm should NOT close a closed
// palette while vim/Claude Code is taking it normally, but SHOULD close an
// open overlay when one is up. Plain number on window for the simplest
// cross-frame read (no proxy, no message passing).
export const OVERLAY_COUNT_KEY = "__citadelOverlayOpen";

type WindowWithCount = Window & { [OVERLAY_COUNT_KEY]?: number };

export function readOverlayCount(): number {
  if (typeof window === "undefined") return 0;
  const value = (window as WindowWithCount)[OVERLAY_COUNT_KEY];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function incrementOverlayCount(): void {
  if (typeof window === "undefined") return;
  const next = readOverlayCount() + 1;
  (window as WindowWithCount)[OVERLAY_COUNT_KEY] = next;
}

export function decrementOverlayCount(): void {
  if (typeof window === "undefined") return;
  const next = Math.max(0, readOverlayCount() - 1);
  (window as WindowWithCount)[OVERLAY_COUNT_KEY] = next;
}

// Mount this hook from any component that renders a top-layer overlay. The
// hook is a no-op during SSR / non-browser test envs so it's safe to import
// anywhere. React 19 StrictMode double-invokes effects in development — the
// effect-and-cleanup pair are symmetric, so the count returns to its prior
// value after the dev-only second invocation.
export function useOverlayPresent(): void {
  useEffect(() => {
    incrementOverlayCount();
    return () => {
      decrementOverlayCount();
    };
  }, []);
}
