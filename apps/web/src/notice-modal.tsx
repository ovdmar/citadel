// Lightweight notice modal — blurred backdrop, Esc / click-outside / Dismiss
// to discard. Used for transient operator advisories (boot-restore status,
// GitHub cooldown) that previously rendered as top-of-cockpit bars and
// couldn't get out of the way of the page.

import { X } from "lucide-react";
import { type ReactNode, useEffect } from "react";

export function NoticeModal(props: {
  title: string;
  onDismiss: () => void;
  children: ReactNode;
}) {
  const { onDismiss } = props;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDismiss]);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onDismiss}>
      <dialog
        open
        className="modal-frame cit-notice-modal"
        aria-label={props.title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <h2>{props.title}</h2>
          <button
            type="button"
            className="cit-notice-modal__close"
            onClick={onDismiss}
            aria-label="Close"
            title="Close (Esc)"
          >
            <X size={14} />
          </button>
        </div>
        <div className="modal-body cit-notice-modal__body">{props.children}</div>
      </dialog>
    </div>
  );
}
