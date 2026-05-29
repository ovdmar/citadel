export type ScratchpadSnapshot = { content: string; updatedAt: string };

// Boundary type for surfaces where MCP clients need to discover the on-disk
// notes file path (HTTP `GET /api/scratchpad`, MCP `read_scratchpad` daemon
// dispatch). Kept as a separate type so internal helpers continue to return
// the narrower `ScratchpadSnapshot` shape without fixture churn.
export type ReadScratchpadResult = ScratchpadSnapshot & { path: string };

export type ScratchpadHistorySource =
  | "ui"
  | "mcp:write_scratchpad"
  | "mcp:append_scratchpad"
  | "mcp:add_block"
  | "mcp:update_block"
  | "mcp:delete_block"
  | "ui:add_block"
  | "ui:edit_block"
  | "ui:delete_block"
  | "migrate-to-blocks"
  | "backfill"
  | `restore:${string}`;

export type ScratchpadHistoryEntry = {
  id: string;
  ts: string;
  firstWriteTs: string;
  source: ScratchpadHistorySource;
  contentSha256: string;
  byteLength: number;
  coalescedCount: number;
  content: string;
};

export type ScratchpadHistorySummary = Omit<ScratchpadHistoryEntry, "content"> & { preview: string };

export type ScratchpadBlock = { id: string; text: string };

export type ScratchpadBlockSummary = ScratchpadBlock & {
  createdAt: string;
  updatedAt: string;
};

export type ScratchpadBlockPosition = "end" | { afterId: string };
