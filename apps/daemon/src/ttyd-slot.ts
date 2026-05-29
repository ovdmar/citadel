// Per-daemon ttyd port slice. Boot-time cleanupStale() blanket-SIGTERMs every
// ttyd in this range, so any two daemons that share a range will trample each
// other's live terminals (worktree daemons under tsx watch restart on file
// save, and each restart used to kill the systemd install's ttyds — that's
// where the "Reconnecting/Reconnected" storm came from).
//
// Layout: slot = ((daemonPort - 4010) mod 11) gives 11 disjoint slices, each
// 1000 ports wide, starting at 11000. The systemd-installed daemon (port
// 4010, slot 0) gets 11000-11999; worktree daemons take other slots. 1000
// ports per daemon is the operational cap on concurrent ttyds — well above
// realistic agent-session counts, but bounded so a leak can't exhaust the
// dynamic port space.
//
// Env overrides (CITADEL_TTYD_PORT_BASE / CITADEL_TTYD_PORT_MAX) still win so
// operators can pin the range explicitly.
const SLOT_COUNT = 11;
const PORTS_PER_SLOT = 1000;
const BASE_PORT = 11000;

export function resolveTtydPortRange(daemonPort: number): { portBase: number; portMax: number } {
  const ttydSlot = (((daemonPort - 4010) % SLOT_COUNT) + SLOT_COUNT) % SLOT_COUNT;
  const envTtydBase = Number.parseInt(process.env.CITADEL_TTYD_PORT_BASE ?? "", 10);
  const envTtydMax = Number.parseInt(process.env.CITADEL_TTYD_PORT_MAX ?? "", 10);
  const portBase =
    Number.isFinite(envTtydBase) && envTtydBase > 0 ? envTtydBase : BASE_PORT + PORTS_PER_SLOT * ttydSlot;
  const portMax = Number.isFinite(envTtydMax) && envTtydMax > 0 ? envTtydMax : portBase + PORTS_PER_SLOT - 1;
  return { portBase, portMax };
}
