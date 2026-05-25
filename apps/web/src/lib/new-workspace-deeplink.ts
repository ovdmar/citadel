// Deeplink helper for the cockpit's Create Workspace modal.
//
// External launchers (e.g. scripts/mac-satellite/new-workspace.sh) jump
// straight into workspace creation by opening the cockpit at
// /?modal=new-workspace. The Cockpit component checks shouldOpenNewWorkspaceModal
// on mount and, if true, opens the existing modal AND strips the param from
// the URL via consumeNewWorkspaceDeeplink so a page refresh doesn't re-open it.

export function shouldOpenNewWorkspaceModal(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.get("modal") === "new-workspace";
}

type HistoryLike = Pick<History, "replaceState">;

export function consumeNewWorkspaceDeeplink(input: {
  pathname: string;
  search: string;
  hash: string;
  history: HistoryLike;
}): void {
  if (!shouldOpenNewWorkspaceModal(input.search)) return;
  const params = new URLSearchParams(input.search);
  params.delete("modal");
  const next = params.toString();
  const url = `${input.pathname}${next ? `?${next}` : ""}${input.hash}`;
  input.history.replaceState({}, "", url);
}
