export type ScratchpadSnapshot = { content: string; updatedAt: string };

export type ScratchpadHistorySource =
  | "ui"
  | "mcp:write_scratchpad"
  | "mcp:append_scratchpad"
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
