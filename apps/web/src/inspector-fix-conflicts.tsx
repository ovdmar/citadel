import { useMutation } from "@tanstack/react-query";
import { GitPullRequest, Loader2 } from "lucide-react";
import { api, queryClient } from "./api.js";

// Renders the "Fix conflicts" action button — visible when the workspace's
// readiness state is "pr-conflicts". POSTs to the daemon's fix-conflicts
// endpoint, which always spawns a fresh agent session (no de-dup by design).
export function FixConflictsButton(props: { workspaceId: string }) {
  const mutation = useMutation({
    mutationFn: () =>
      api<{ session: { id: string }; promptSource: string }>(`/api/workspaces/${props.workspaceId}/fix-conflicts`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["state"] });
      queryClient.invalidateQueries({ queryKey: ["cockpit-summary", props.workspaceId] });
    },
  });
  return (
    <div className="ins-pr-fix">
      <button
        type="button"
        className="cit-btn cit-btn-danger"
        onClick={() => mutation.mutate()}
        disabled={mutation.isPending}
        title="Launch a fresh agent to resolve PR conflicts against main"
      >
        {mutation.isPending ? <Loader2 size={11} className="spin" /> : <GitPullRequest size={11} />}
        {mutation.isPending ? "Launching…" : "Fix conflicts"}
      </button>
      {mutation.isError ? (
        <span className="ins-pr-fix-err">
          {mutation.error instanceof Error ? mutation.error.message : "Failed to launch agent"}
        </span>
      ) : null}
    </div>
  );
}
