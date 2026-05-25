// Pure presentation + coordination helpers for the scratchpad route. Kept
// separate from the React component so they can be unit-tested without DOM
// infrastructure.

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function pillSlug(source: string): string {
  if (source.startsWith("restore:")) return "restore";
  if (source === "mcp:write_scratchpad") return "mcp-write";
  if (source === "mcp:append_scratchpad") return "mcp-append";
  return source;
}

export function pillLabel(source: string): string {
  if (source === "ui") return "UI";
  if (source === "mcp:write_scratchpad") return "MCP write";
  if (source === "mcp:append_scratchpad") return "MCP append";
  if (source === "backfill") return "Backfill";
  if (source.startsWith("restore:")) return "Restore";
  return source;
}

// Single-flight save coordinator. Mirrors the loop inside the React component
// but is dependency-injected so it can be exercised in isolation. The component
// passes refs/callbacks; the coordinator is the rules-of-engagement.
export type SaveCoordinatorState = {
  saving: boolean;
  pendingRefresh: boolean;
};

export type SaveCoordinatorDeps = {
  getLatest: () => string;
  getLastSaved: () => string;
  setLastSaved: (value: string) => void;
  put: (snapshot: string) => Promise<{ content: string }>;
  load: () => Promise<void>;
  onSaveStart?: () => void;
  onSaveFinish?: () => void;
};

export function createSaveCoordinator(deps: SaveCoordinatorDeps) {
  const state: SaveCoordinatorState = { saving: false, pendingRefresh: false };

  async function save(): Promise<void> {
    if (state.saving) return;
    state.saving = true;
    deps.onSaveStart?.();
    try {
      while (deps.getLatest() !== deps.getLastSaved()) {
        const snapshot = deps.getLatest();
        const result = await deps.put(snapshot);
        deps.setLastSaved(result.content);
      }
    } finally {
      state.saving = false;
      deps.onSaveFinish?.();
      if (state.pendingRefresh) {
        state.pendingRefresh = false;
        await deps.load();
      }
    }
  }

  function noteSseRefresh(): "queued" | "immediate" {
    if (state.saving) {
      state.pendingRefresh = true;
      return "queued";
    }
    void deps.load();
    return "immediate";
  }

  return { save, noteSseRefresh, state };
}
