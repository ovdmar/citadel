// Thin redirect for the `/scratchpad` deep-link.
//
// The scratchpad UI now lives in a drawer (`ScratchpadPanel`) mounted once at
// the Shell level (see `main.tsx`). Visiting `/scratchpad` opens the drawer
// and rewrites the URL to `<last-route>?scratchpad=1` (or `/?scratchpad=1`
// when there is no remembered route) so subsequent navigation preserves the
// drawer state via the query param.
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { loadLastRoute } from "../lib/last-route.js";
import { setScratchpadDrawerOpen } from "../scratchpad-drawer-store.js";

export function ScratchpadView() {
  const navigate = useNavigate();

  useEffect(() => {
    setScratchpadDrawerOpen(true);
    const last = loadLastRoute();
    // last-route's EXCLUDED_PREFIXES already filters out /scratchpad on save,
    // but defend against stale storage by guarding here too.
    const target =
      last && last !== "/" && !last.startsWith("/scratchpad") ? appendScratchpadParam(last) : "/?scratchpad=1";
    void navigate({ to: target, replace: true });
  }, [navigate]);

  return (
    <div className="scratchpad-redirect" aria-busy="true">
      Opening scratchpad…
    </div>
  );
}

function appendScratchpadParam(href: string): string {
  // href can already carry a query string and/or a hash; preserve both.
  const [pathAndQuery, ...rest] = href.split("#", 1);
  const hash = href.length > (pathAndQuery?.length ?? 0) ? href.slice((pathAndQuery?.length ?? 0) + 1) : "";
  const base = pathAndQuery ?? href;
  const joiner = base.includes("?") ? "&" : "?";
  const next = `${base}${joiner}scratchpad=1`;
  return hash ? `${next}#${hash}` : next;
}

export const __testing__ = { appendScratchpadParam };
