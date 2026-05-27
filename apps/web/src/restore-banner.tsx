// Boot-time restore banner. Shown once per daemon boot when the daemon's
// auto-restore (apps/daemon/src/boot-restore.ts) brought sessions back from
// a previous run. Dismissal is keyed by bootedAt so the next boot's banner
// surfaces again without the user having to "forget" the previous dismissal.

import { useEffect, useState } from "react";
import type { BootRestoreSummary } from "./app-state.js";
import { RestoreModal } from "./settings-restore.js";

const DISMISS_STORAGE_KEY = "citadel.restore-banner.dismissedBootedAt";

export function RestoreBanner(props: { bootRestore: BootRestoreSummary | null }) {
  const { bootRestore } = props;
  const [dismissedBootedAt, setDismissedBootedAt] = useState<string | null>(() => {
    try {
      return window.localStorage.getItem(DISMISS_STORAGE_KEY);
    } catch {
      return null;
    }
  });
  const [modalOpen, setModalOpen] = useState(false);

  // Refresh dismissed state if the boot summary changes underneath us — e.g.
  // the daemon was restarted while the cockpit was open. New bootedAt means
  // any previous dismissal no longer applies.
  useEffect(() => {
    if (!bootRestore) return;
    if (dismissedBootedAt && dismissedBootedAt !== bootRestore.bootedAt) {
      setDismissedBootedAt(null);
    }
  }, [bootRestore, dismissedBootedAt]);

  if (!bootRestore) return null;
  if (bootRestore.entries.length === 0) return null;
  if (dismissedBootedAt === bootRestore.bootedAt) return null;

  const succeeded = bootRestore.entries.filter((e) => e.sessionId && !e.error).length;
  const failed = bootRestore.entries.filter((e) => e.error).length;
  const inProgress = bootRestore.entries.length - succeeded - failed;
  const total = bootRestore.entries.length;

  const dismiss = () => {
    try {
      window.localStorage.setItem(DISMISS_STORAGE_KEY, bootRestore.bootedAt);
    } catch {
      // Storage unavailable (e.g. private mode) — fall back to in-memory only.
    }
    setDismissedBootedAt(bootRestore.bootedAt);
  };

  const message =
    inProgress > 0
      ? `Restoring ${total} session${total === 1 ? "" : "s"} from previous run (${succeeded} done${
          failed > 0 ? `, ${failed} failed` : ""
        })`
      : failed > 0
        ? `Restored ${succeeded} of ${total} sessions from previous run — ${failed} failed`
        : `Restored ${total} session${total === 1 ? "" : "s"} from previous run`;

  const hasSkipped = bootRestore.skippedOlder > 0;
  const skippedHint = hasSkipped
    ? ` (${bootRestore.skippedOlder} older session${bootRestore.skippedOlder === 1 ? "" : "s"} not restored)`
    : "";

  return (
    <>
      <output className="cit-restore-banner">
        <span className="cit-restore-banner__msg">
          {message}
          {skippedHint}
        </span>
        {hasSkipped || failed > 0 ? (
          <button type="button" className="cit-restore-banner__open" onClick={() => setModalOpen(true)}>
            Open restore
          </button>
        ) : null}
        <button type="button" className="cit-restore-banner__dismiss" onClick={dismiss}>
          Dismiss
        </button>
      </output>
      {modalOpen ? <RestoreModal onClose={() => setModalOpen(false)} /> : null}
    </>
  );
}
