import { isBareRootLanding } from "./last-route.js";

// Match the breakpoint baked into apps/web/src/styles.css and responsive.css —
// keep the value here in sync so the redirect threshold and the mobile CSS
// kick in at the same width.
export const MOBILE_MEDIA_QUERY = "(max-width: 820px)";

// Returns the scratchpad path when the user is landing on the bare root on a
// narrow viewport, so the scratchpad becomes the first view on mobile. Returns
// null in every other case — any deep link (different pathname, or root with
// search/hash, e.g. /?modal=new-workspace) wins over the mobile default.
export function mobileScratchpadRedirect(
  loc: Pick<Location, "pathname" | "search" | "hash">,
  narrow: boolean,
): "/scratchpad" | null {
  if (!narrow) return null;
  if (!isBareRootLanding(loc)) return null;
  return "/scratchpad";
}
