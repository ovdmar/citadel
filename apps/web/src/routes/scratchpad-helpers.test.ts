import { describe, expect, it } from "vitest";
import { formatBytes, pillLabel, pillSlug } from "./scratchpad-helpers.js";

describe("formatBytes", () => {
  it("renders bytes under 1 KB plainly", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("crosses to KB at 1024", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(1024 * 1024 - 1)).toMatch(/KB$/);
  });

  it("crosses to MB at 1 MiB", () => {
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("pillSlug", () => {
  it("maps known sources to slug classes", () => {
    expect(pillSlug("ui")).toBe("ui");
    expect(pillSlug("mcp:write_scratchpad")).toBe("mcp-write");
    expect(pillSlug("mcp:append_scratchpad")).toBe("mcp-append");
    expect(pillSlug("backfill")).toBe("backfill");
    expect(pillSlug("restore:scratch_123_abc")).toBe("restore");
  });

  it("maps new block-level sources to dedicated slugs", () => {
    expect(pillSlug("mcp:add_block")).toBe("mcp-add-block");
    expect(pillSlug("mcp:update_block")).toBe("mcp-update-block");
    expect(pillSlug("mcp:delete_block")).toBe("mcp-delete-block");
    expect(pillSlug("ui:add_block")).toBe("ui-add-block");
    expect(pillSlug("ui:edit_block")).toBe("ui-edit-block");
    expect(pillSlug("ui:delete_block")).toBe("ui-delete-block");
    expect(pillSlug("migrate-to-blocks")).toBe("migrate");
  });

  it("passes unknown sources through unchanged", () => {
    expect(pillSlug("custom")).toBe("custom");
  });
});

describe("pillLabel", () => {
  it("renders friendly labels for each source", () => {
    expect(pillLabel("ui")).toBe("UI");
    expect(pillLabel("mcp:write_scratchpad")).toBe("MCP write");
    expect(pillLabel("mcp:append_scratchpad")).toBe("MCP append");
    expect(pillLabel("backfill")).toBe("Backfill");
    expect(pillLabel("restore:abc")).toBe("Restore");
    expect(pillLabel("custom")).toBe("custom");
  });

  it("renders friendly labels for new block-level sources", () => {
    expect(pillLabel("mcp:add_block")).toBe("MCP add");
    expect(pillLabel("mcp:update_block")).toBe("MCP update");
    expect(pillLabel("mcp:delete_block")).toBe("MCP delete");
    expect(pillLabel("ui:add_block")).toBe("UI add");
    expect(pillLabel("ui:edit_block")).toBe("UI edit");
    expect(pillLabel("ui:delete_block")).toBe("UI delete");
    expect(pillLabel("migrate-to-blocks")).toBe("Migrate");
  });
});
