import type { WorkspaceSession } from "@citadel/contracts";
import { MoreHorizontal, RefreshCw, RotateCcw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export function StageTabActionMenu(props: {
  session: WorkspaceSession;
  label: string;
  canReloadAgentSession: boolean;
  reloadingAgentSession: boolean;
  onReloadTerminal: () => void;
  onReloadAgentSession: () => void;
  onStopSession: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLSpanElement | null>(null);
  const showReloadSession = props.session.kind === "agent";

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onViewportMove = () => setOpen(false);
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onViewportMove);
    window.addEventListener("scroll", onViewportMove, true);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onViewportMove);
      window.removeEventListener("scroll", onViewportMove, true);
    };
  }, [open]);

  const openFrom = (button: HTMLButtonElement) => {
    const rect = button.getBoundingClientRect();
    const menuWidth = 180;
    setMenuPosition({
      top: rect.bottom + 4,
      left: Math.max(8, Math.min(rect.left, window.innerWidth - menuWidth - 8)),
    });
    setOpen(true);
  };

  const run = (action: () => void) => {
    setOpen(false);
    action();
  };

  return (
    <span className="stage-tab-menu-wrapper" ref={ref}>
      <button
        type="button"
        className="stage-tab-menu-trigger"
        aria-label={`Open actions for ${props.label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Session actions"
        onClick={(event) => {
          event.stopPropagation();
          if (open) setOpen(false);
          else openFrom(event.currentTarget);
        }}
      >
        <MoreHorizontal size={13} />
      </button>
      {open ? (
        <span className="stage-tab-menu" role="menu" style={menuPosition ?? undefined}>
          <button
            type="button"
            role="menuitem"
            onClick={(event) => {
              event.stopPropagation();
              run(props.onReloadTerminal);
            }}
          >
            <RefreshCw size={12} />
            Reload view
          </button>
          {showReloadSession ? (
            <button
              type="button"
              role="menuitem"
              disabled={!props.canReloadAgentSession || props.reloadingAgentSession}
              onClick={(event) => {
                event.stopPropagation();
                run(props.onReloadAgentSession);
              }}
            >
              <RotateCcw size={12} />
              Reload session
            </button>
          ) : null}
          <button
            type="button"
            role="menuitem"
            onClick={(event) => {
              event.stopPropagation();
              run(props.onStopSession);
            }}
          >
            <X size={12} />
            Close tab
          </button>
        </span>
      ) : null}
    </span>
  );
}
