import type { WorkspaceCockpitSummary } from "@citadel/contracts";
import { useEffect, useState } from "react";
import { selectActiveGhCooldown } from "./cockpit-tools.js";

// Single top-of-cockpit pill rendered while ANY workspace's
// versionControl.cooldownUntil is in the future. Reads the soonest cooldown
// across the sticky summary cache so the operator sees one banner per
// cockpit, not one per workspace. Last-known PR data underneath stays
// visible — the cockpit's normal layout doesn't shift, the banner just
// stacks on top alongside RestoreBanner.

export function GhCooldownBanner(props: { summaries: Map<string, WorkspaceCockpitSummary> }) {
  const { summaries } = props;
  // Re-render once per minute so the "retrying at HH:MM" text doesn't tick
  // stale. Cheaper than a useInterval — a 60s setInterval is plenty since
  // the timestamp is already rounded to minutes for display.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const handle = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(handle);
  }, []);

  const active = selectActiveGhCooldown(summaries, now);
  if (!active) return null;

  const retryAt = new Date(active.until);
  const hh = String(retryAt.getHours()).padStart(2, "0");
  const mm = String(retryAt.getMinutes()).padStart(2, "0");

  return (
    <output className="cit-restore-banner cit-gh-cooldown-banner">
      <span className="cit-restore-banner__msg">
        GitHub rate-limited — retrying at {hh}:{mm}
      </span>
    </output>
  );
}
