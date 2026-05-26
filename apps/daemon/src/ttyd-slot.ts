// Per-daemon ttyd port slice. Boot-time cleanupStale() blanket-SIGTERMs
// every ttyd in this range, so any two daemons that share a range will
// trample each other's live terminals (worktree daemons under tsx watch
// restart on file save, and each restart killed the systemd install's
// ttyds — that's where the "Reconnecting/Reconnected" storm came from).
//
// Slot = ((daemonPort - 4010) mod 11) * 200 gives 11 disjoint 200-port
// slices, each deterministic per HTTP port. The base is shifted to 7721
// (just above the legacy hardcoded ceiling of 7720) so daemons running
// OLD pre-slot code — whose cleanupStale still targets the legacy
// 7681..7720 range — physically cannot reach new daemons' terminals.
// Env overrides still win so operators can pin the range explicitly.
export function resolveTtydPortRange(daemonPort: number): { portBase: number; portMax: number } {
  const ttydSlot = (((daemonPort - 4010) % 11) + 11) % 11;
  const envTtydBase = Number.parseInt(process.env.CITADEL_TTYD_PORT_BASE ?? "", 10);
  const envTtydMax = Number.parseInt(process.env.CITADEL_TTYD_PORT_MAX ?? "", 10);
  const portBase = Number.isFinite(envTtydBase) && envTtydBase > 0 ? envTtydBase : 7721 + 200 * ttydSlot;
  const portMax = Number.isFinite(envTtydMax) && envTtydMax > 0 ? envTtydMax : portBase + 199;
  return { portBase, portMax };
}
