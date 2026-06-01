// Module-level singleton holding the daemon's last observed view of who owns
// the citadel-tmux socket. Set once at boot by index.ts (after attempting to
// auto-start citadel-tmux.service), read by /api/health so the cockpit can
// show a degraded banner when the tmux server is unsupervised or absent.
//
// Why a singleton and not a per-request probe: the probe shells out to
// `fuser` + `systemctl show`, which is fine at boot but would add ~20ms to
// every health poll. The state is set on boot and updated by ensureTmuxSession
// callers when they detect drift. Refresh on demand via setTmuxOwnership.

import type { TmuxServerOwnership } from "@citadel/terminal";

let currentOwnership: TmuxServerOwnership = { kind: "absent" };
let lastUpdatedAt: string | null = null;

export function setTmuxOwnership(ownership: TmuxServerOwnership) {
  currentOwnership = ownership;
  lastUpdatedAt = new Date().toISOString();
}

export function getTmuxOwnership(): { ownership: TmuxServerOwnership; lastUpdatedAt: string | null } {
  return { ownership: currentOwnership, lastUpdatedAt };
}
