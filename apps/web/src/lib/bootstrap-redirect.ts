import { bootstrapLastRoute } from "./last-route.js";
import { MOBILE_MEDIA_QUERY, mobileScratchpadRedirect } from "./mobile-redirect.js";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type HistoryLike = Pick<History, "replaceState">;

export type BootstrapNavigationInput = {
  location: Pick<Location, "pathname" | "search" | "hash">;
  history: HistoryLike;
  storage?: StorageLike | null;
  narrow: boolean;
};

// Synchronous pre-router navigation gate. Runs the mobile-scratchpad redirect
// BEFORE bootstrapLastRoute so a mobile user with a persisted desktop route
// (e.g. /settings) still lands on the scratchpad — which is what AC2 promises
// ("scratchpad is the first view that opens on mobile"). On wide viewports the
// mobile rule no-ops and bootstrapLastRoute owns the decision unchanged.
export function applyBootstrapNavigation(input: BootstrapNavigationInput): void {
  const { location, history, narrow } = input;
  const mobileTarget = mobileScratchpadRedirect(location, narrow);
  if (mobileTarget) {
    history.replaceState({}, "", mobileTarget);
    return;
  }
  bootstrapLastRoute(location, history, input.storage ?? null);
}

export function applyBootstrapNavigationFromWindow(): void {
  if (typeof window === "undefined") return;
  const narrow = window.matchMedia(MOBILE_MEDIA_QUERY).matches;
  applyBootstrapNavigation({
    location: window.location,
    history: window.history,
    narrow,
  });
}
