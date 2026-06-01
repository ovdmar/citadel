export type OrphanReaperSafetyInput = {
  daemonPort: number;
  explicitDataDirOverride: boolean;
  ownsTmuxSocket: boolean;
  disableOrphanReaper?: string | undefined;
  allowSharedTmuxReaper?: string | undefined;
};

export function shouldReapTmuxOrphans(input: OrphanReaperSafetyInput): boolean {
  if (input.disableOrphanReaper === "1") return false;
  if (input.ownsTmuxSocket) return true;
  if (input.allowSharedTmuxReaper === "1") return true;

  // The installed daemon is the only default shared-socket owner. Ad-hoc
  // sandboxes often point CITADEL_DATA_DIR at /tmp while inheriting
  // CITADEL_TMUX_SOCKET=citadel; they must never reap shared-socket panes.
  return input.daemonPort === 4010 && !input.explicitDataDirOverride;
}
