import type { WorkspaceCockpitSummary } from "@citadel/contracts";
import { useEffect, useState } from "react";
import { selectActiveGhCooldown } from "./cockpit-tools.js";
import { NoticeModal } from "./notice-modal.js";

// Single GitHub-cooldown notice rendered while ANY workspace's
// versionControl.cooldownUntil is in the future. Dismissal is keyed by the
// cooldown's `until` timestamp so a new cooldown event re-surfaces the
// notice without the user having to clear storage.

const DISMISS_STORAGE_KEY = "citadel.gh-cooldown.dismissedUntil";

export function GhCooldownBanner(props: { summaries: Map<string, WorkspaceCockpitSummary> }) {
  const { summaries } = props;
  // Re-render once per minute so the "retrying at HH:MM" text doesn't tick
  // stale and so an expired cooldown drops the modal without a page event.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const handle = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(handle);
  }, []);

  const [dismissedUntil, setDismissedUntil] = useState<string | null>(() => {
    try {
      return window.localStorage.getItem(DISMISS_STORAGE_KEY);
    } catch {
      return null;
    }
  });

  const active = selectActiveGhCooldown(summaries, now);

  // Forget a stale dismissal once its window has passed — otherwise a single
  // long-lived dismissed value would suppress every future cooldown notice.
  useEffect(() => {
    if (!dismissedUntil) return;
    const dismissedTime = Date.parse(dismissedUntil);
    if (Number.isFinite(dismissedTime) && dismissedTime <= now) {
      setDismissedUntil(null);
      try {
        window.localStorage.removeItem(DISMISS_STORAGE_KEY);
      } catch {
        // ignore
      }
    }
  }, [dismissedUntil, now]);

  if (!active) return null;
  if (dismissedUntil === active.iso) return null;

  const retryAt = new Date(active.iso);
  const hh = String(retryAt.getHours()).padStart(2, "0");
  const mm = String(retryAt.getMinutes()).padStart(2, "0");

  const dismiss = () => {
    try {
      window.localStorage.setItem(DISMISS_STORAGE_KEY, active.iso);
    } catch {
      // ignore
    }
    setDismissedUntil(active.iso);
  };

  return (
    <NoticeModal title="GitHub rate-limited" onDismiss={dismiss}>
      <p>
        Citadel paused GitHub requests until{" "}
        <strong>
          {hh}:{mm}
        </strong>
        . PR and CI data will keep showing the last successful snapshot until the cooldown lifts.
      </p>
      <p className="cit-notice-modal__hint">
        The cockpit stays usable while this is dismissed; the notice will re-appear if a new cooldown is triggered.
      </p>
      <div className="cit-notice-modal__actions">
        <button type="button" className="cit-notice-modal__primary" onClick={dismiss}>
          Dismiss
        </button>
      </div>
    </NoticeModal>
  );
}
