import type { ScheduledAgent } from "@citadel/contracts";
import { useMutation } from "@tanstack/react-query";
import { useEffect } from "react";
import { api, queryClient } from "./api.js";
import { useOverlayPresent } from "./use-overlay-present.js";

export function DeleteScheduledAgentDialog(props: {
  agent: ScheduledAgent;
  onClose: () => void;
  onDeleted?: () => void;
}) {
  useOverlayPresent();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.onClose]);

  const remove = useMutation({
    mutationFn: () => api(`/api/scheduled-agents/${props.agent.id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["state"] });
      props.onDeleted?.();
      props.onClose();
    },
  });

  return (
    <div className="sched-delete-backdrop" role="presentation" onMouseDown={props.onClose}>
      <dialog
        className="sched-delete-dialog"
        aria-label={`Delete scheduled agent ${props.agent.name}`}
        open
        onMouseDown={(event) => event.stopPropagation()}
      >
        <strong>Delete "{props.agent.name}"?</strong>
        <p>
          This removes the schedule, its run history, and any background sessions it owns. Background tmux panes are
          killed. This cannot be undone.
        </p>
        {remove.error instanceof Error ? <p className="sched-delete-error">{remove.error.message}</p> : null}
        <div className="sched-delete-actions">
          <button type="button" className="sched-delete-cancel" onClick={props.onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="sched-delete-confirm"
            onClick={() => remove.mutate()}
            disabled={remove.isPending}
          >
            {remove.isPending ? "Deleting…" : "Delete scheduled agent"}
          </button>
        </div>
      </dialog>
    </div>
  );
}
