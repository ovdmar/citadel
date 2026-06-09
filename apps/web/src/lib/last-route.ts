// Persists the most recently visited route so reloads (and full close+reopen)
// land the user back where they were, rather than on the default cockpit view.

const STORAGE_KEY = "citadel:lastRoute";

// Path prefixes that should never be persisted as "where the user left off".
// /scratchpad is the one-shot deep-link to the scratchpad drawer; persisting
// it would cause the drawer's redirect-on-mount to loop back to itself instead
// of restoring whichever cockpit view the user was actually on. Other routes
// (including /onboarding) are fair game so a user who closes mid-setup resumes
// in the wizard.
const EXCLUDED_PREFIXES: readonly string[] = ["/scratchpad"];

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function getStorage(): StorageLike | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadLastRoute(storage: StorageLike | null = getStorage()): string | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw || !isSafeAbsolutePath(raw)) return null;
    return raw;
  } catch {
    return null;
  }
}

export function saveLastRoute(href: string, storage: StorageLike | null = getStorage()): void {
  if (!storage) return;
  if (!isSafeAbsolutePath(href)) return;
  if (isExcluded(href)) return;
  try {
    storage.setItem(STORAGE_KEY, href);
  } catch {
    // Storage may be unavailable (Safari private mode, quota errors). Restoring
    // is a nice-to-have, not a correctness requirement — silently skip.
  }
}

export function clearLastRoute(storage: StorageLike | null = getStorage()): void {
  if (!storage) return;
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

// Only restore when the user landed on the bare app root. Any deep link
// (non-root pathname, or root with a query/hash) is an explicit intent that
// must win over the saved value.
export function isBareRootLanding(loc: Pick<Location, "pathname" | "search" | "hash">): boolean {
  return loc.pathname === "/" && loc.search === "" && loc.hash === "";
}

type HistoryLike = Pick<History, "replaceState">;

// Decide whether to restore the persisted route and, if so, swap it into the
// URL bar before the router boots. Exported as a pure function so the decision
// logic (not just the storage layer) is unit-testable.
export function bootstrapLastRoute(
  location: Pick<Location, "pathname" | "search" | "hash">,
  history: HistoryLike,
  storage: StorageLike | null = getStorage(),
): string | null {
  if (!isBareRootLanding(location)) return null;
  const saved = loadLastRoute(storage);
  if (!saved || saved === "/") return null;
  history.replaceState(null, "", saved);
  return saved;
}

function isExcluded(href: string): boolean {
  const url = new URL(href, "http://citadel.local");
  if (url.searchParams.get("scratchpad") === "1") return true;
  const path = url.pathname;
  return EXCLUDED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

// Only accept same-origin absolute paths. Rejects protocol-relative URLs like
// "//evil.com/x" and backslash variants that some browsers normalize to "/" —
// a value passed to history.replaceState should never be able to spoof origin.
function isSafeAbsolutePath(value: string): boolean {
  if (value.length === 0) return false;
  if (value[0] !== "/") return false;
  if (value[1] === "/" || value[1] === "\\") return false;
  return true;
}
