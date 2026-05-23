// Persists the most recently visited route so reloads (and full close+reopen)
// land the user back where they were, rather than on the default cockpit view.

const STORAGE_KEY = "citadel:lastRoute";

// Path prefixes that should never be persisted as "where the user left off".
// Empty today — every navigable view is fair game, including /onboarding so a
// user who closes mid-setup resumes in the wizard.
const EXCLUDED_PREFIXES: readonly string[] = [];

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
    if (!raw || !raw.startsWith("/")) return null;
    return raw;
  } catch {
    return null;
  }
}

export function saveLastRoute(href: string, storage: StorageLike | null = getStorage()): void {
  if (!storage) return;
  if (!href.startsWith("/")) return;
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

function isExcluded(href: string): boolean {
  const path = href.split("?", 1)[0]?.split("#", 1)[0] ?? href;
  return EXCLUDED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}
