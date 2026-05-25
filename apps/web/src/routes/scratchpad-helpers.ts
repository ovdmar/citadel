// Pure presentation helpers for the scratchpad route. Kept separate from the
// React component so they can be unit-tested without DOM infrastructure.

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function pillSlug(source: string): string {
  if (source.startsWith("restore:")) return "restore";
  if (source === "mcp:write_scratchpad") return "mcp-write";
  if (source === "mcp:append_scratchpad") return "mcp-append";
  if (source === "mcp:add_block") return "mcp-add-block";
  if (source === "mcp:update_block") return "mcp-update-block";
  if (source === "mcp:delete_block") return "mcp-delete-block";
  if (source === "ui:add_block") return "ui-add-block";
  if (source === "ui:edit_block") return "ui-edit-block";
  if (source === "ui:delete_block") return "ui-delete-block";
  if (source === "migrate-to-blocks") return "migrate";
  return source;
}

export function pillLabel(source: string): string {
  if (source === "ui") return "UI";
  if (source === "mcp:write_scratchpad") return "MCP write";
  if (source === "mcp:append_scratchpad") return "MCP append";
  if (source === "mcp:add_block") return "MCP add";
  if (source === "mcp:update_block") return "MCP update";
  if (source === "mcp:delete_block") return "MCP delete";
  if (source === "ui:add_block") return "UI add";
  if (source === "ui:edit_block") return "UI edit";
  if (source === "ui:delete_block") return "UI delete";
  if (source === "migrate-to-blocks") return "Migrate";
  if (source === "backfill") return "Backfill";
  if (source.startsWith("restore:")) return "Restore";
  return source;
}
