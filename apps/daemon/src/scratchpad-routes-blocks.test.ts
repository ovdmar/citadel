import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createDaemonApp } from "./app.js";
import { serializeBlocks } from "./scratchpad-blocks.js";
import {
  closeServer,
  createScratchpadFixture,
  getJson,
  listen,
  openHistorySseListener,
  openSseListener,
  postJson,
  putJson,
} from "./scratchpad-routes.test-utils.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

process.env.CITADEL_DISABLE_REAPER = "1";

const createFixture = () => createScratchpadFixture(dirs);

describe("scratchpad block routes + MCP block tools", () => {
  it("exposes list_blocks / add_block / update_block / delete_block via MCP", async () => {
    const fixture = createFixture();
    const { server } = await createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const added = await postJson<{ result: { structuredContent: { block: { id: string } } } }>(
        `${baseUrl}/api/mcp/rpc`,
        {
          jsonrpc: "2.0",
          id: "add",
          method: "tools/call",
          params: { name: "add_block", arguments: { text: "via mcp add" } },
        },
      );
      const addedId = added.result.structuredContent.block.id;
      expect(addedId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

      const listed = await postJson<{ result: { structuredContent: { blocks: Array<{ id: string; text: string }> } } }>(
        `${baseUrl}/api/mcp/rpc`,
        { jsonrpc: "2.0", id: "ls", method: "tools/call", params: { name: "list_blocks" } },
      );
      expect(listed.result.structuredContent.blocks).toHaveLength(1);
      expect(listed.result.structuredContent.blocks[0]?.text).toBe("via mcp add");

      const removed = await postJson<{ result: { structuredContent: Record<string, unknown> } }>(
        `${baseUrl}/api/mcp/rpc`,
        {
          jsonrpc: "2.0",
          id: "del-via-update",
          method: "tools/call",
          params: { name: "update_block", arguments: { id: addedId, text: "" } },
        },
      );
      expect(removed.result.structuredContent).not.toHaveProperty("error");
      expect(removed.result.structuredContent).not.toHaveProperty("block");

      const missing = await postJson<{ result: { structuredContent: { error: string } } }>(`${baseUrl}/api/mcp/rpc`, {
        jsonrpc: "2.0",
        id: "del-missing",
        method: "tools/call",
        params: { name: "delete_block", arguments: { id: "nope" } },
      });
      expect(missing.result.structuredContent.error).toBe("block_not_found");
    } finally {
      await closeServer(server);
    }
  });

  it("GET /api/scratchpad/blocks lists fenced blocks", async () => {
    const fixture = createFixture();
    const { server } = await createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      await postJson(`${baseUrl}/api/scratchpad/blocks`, { text: "first" });
      await postJson(`${baseUrl}/api/scratchpad/blocks`, { text: "second" });
      const list = await getJson<{ blocks: Array<{ id: string; text: string; createdAt: string; updatedAt: string }> }>(
        `${baseUrl}/api/scratchpad/blocks`,
      );
      expect(list.blocks).toHaveLength(2);
      expect(list.blocks[0]?.text).toBe("first");
      expect(list.blocks[1]?.text).toBe("second");
      for (const b of list.blocks) {
        expect(b.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        expect(typeof b.createdAt).toBe("string");
        expect(typeof b.updatedAt).toBe("string");
      }
    } finally {
      await closeServer(server);
    }
  });

  it("POST /api/scratchpad/blocks supports position {afterId} and validates input", async () => {
    const fixture = createFixture();
    const { server } = await createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const a = await postJson<{ block: { id: string } }>(`${baseUrl}/api/scratchpad/blocks`, { text: "a" });
      await postJson(`${baseUrl}/api/scratchpad/blocks`, { text: "c" });
      await postJson(`${baseUrl}/api/scratchpad/blocks`, {
        text: "b",
        position: { afterId: a.block.id },
      });
      const list = await getJson<{ blocks: Array<{ text: string }> }>(`${baseUrl}/api/scratchpad/blocks`);
      expect(list.blocks.map((b) => b.text)).toEqual(["a", "b", "c"]);

      const notFound = await fetch(`${baseUrl}/api/scratchpad/blocks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "x", position: { afterId: "missing" } }),
      });
      expect(notFound.status).toBe(404);

      const empty = await fetch(`${baseUrl}/api/scratchpad/blocks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "" }),
      });
      expect(empty.status).toBe(400);
      const emptyBody = (await empty.json()) as { error: string };
      expect(emptyBody.error).toBe("text_required");
    } finally {
      await closeServer(server);
    }
  });

  it("PUT /api/scratchpad/blocks/:id updates; empty text deletes; unknown id 404s", async () => {
    const fixture = createFixture();
    const { server } = await createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const a = await postJson<{ block: { id: string; text: string } }>(`${baseUrl}/api/scratchpad/blocks`, {
        text: "old",
      });
      const updated = await putJson<{ block: { id: string; text: string } }>(
        `${baseUrl}/api/scratchpad/blocks/${a.block.id}`,
        { text: "new" },
      );
      expect(updated.block.id).toBe(a.block.id);
      expect(updated.block.text).toBe("new");

      const deleted = await fetch(`${baseUrl}/api/scratchpad/blocks/${a.block.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "   " }),
      });
      expect(deleted.status).toBe(200);
      const list = await getJson<{ blocks: unknown[] }>(`${baseUrl}/api/scratchpad/blocks`);
      expect(list.blocks).toHaveLength(0);

      const missing = await fetch(`${baseUrl}/api/scratchpad/blocks/missing`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "anything" }),
      });
      expect(missing.status).toBe(404);
    } finally {
      await closeServer(server);
    }
  });

  it("DELETE /api/scratchpad/blocks/:id removes the block; unknown id 404s", async () => {
    const fixture = createFixture();
    const { server } = await createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const a = await postJson<{ block: { id: string } }>(`${baseUrl}/api/scratchpad/blocks`, { text: "one" });
      const b = await postJson<{ block: { id: string } }>(`${baseUrl}/api/scratchpad/blocks`, { text: "two" });
      const del = await fetch(`${baseUrl}/api/scratchpad/blocks/${a.block.id}`, { method: "DELETE" });
      expect(del.status).toBe(200);
      const list = await getJson<{ blocks: Array<{ id: string }> }>(`${baseUrl}/api/scratchpad/blocks`);
      expect(list.blocks.map((x) => x.id)).toEqual([b.block.id]);
      const missing = await fetch(`${baseUrl}/api/scratchpad/blocks/missing`, { method: "DELETE" });
      expect(missing.status).toBe(404);
    } finally {
      await closeServer(server);
    }
  });

  it("block routes emit scratchpad.history.updated", async () => {
    const fixture = createFixture();
    const { server } = await createDaemonApp(fixture);
    const baseUrl = await listen(server);
    const listener = await openHistorySseListener(baseUrl);
    try {
      const a = await postJson<{ block: { id: string } }>(`${baseUrl}/api/scratchpad/blocks`, { text: "first" });
      await putJson(`${baseUrl}/api/scratchpad/blocks/${a.block.id}`, { text: "second" });
      await fetch(`${baseUrl}/api/scratchpad/blocks/${a.block.id}`, { method: "DELETE" });
      const events = await listener.waitFor(3, 2_000);
      expect(events.length).toBeGreaterThanOrEqual(3);
    } finally {
      listener.close();
      await closeServer(server);
    }
  });

  it("block routes emit scratchpad.updated on every mutation (used by the cockpit refresh)", async () => {
    const fixture = createFixture();
    const { server } = await createDaemonApp(fixture);
    const baseUrl = await listen(server);
    const listener = await openSseListener(baseUrl, "scratchpad.updated");
    try {
      const a = await postJson<{ block: { id: string } }>(`${baseUrl}/api/scratchpad/blocks`, { text: "first" });
      await putJson(`${baseUrl}/api/scratchpad/blocks/${a.block.id}`, { text: "second" });
      await fetch(`${baseUrl}/api/scratchpad/blocks/${a.block.id}`, { method: "DELETE" });
      const events = await listener.waitFor(3, 2_000);
      expect(events.length).toBeGreaterThanOrEqual(3);
    } finally {
      listener.close();
      await closeServer(server);
    }
  });

  it("POST /api/scratchpad/blocks returns 413 when adding a block would push past the size cap", async () => {
    const fixture = createFixture();
    const { server } = await createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      await postJson(`${baseUrl}/api/scratchpad/blocks`, { text: "x".repeat(999_500) });
      const oversize = await fetch(`${baseUrl}/api/scratchpad/blocks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "y".repeat(2_000) }),
      });
      expect(oversize.status).toBe(413);
      const body = (await oversize.json()) as { error: string; limit?: number };
      expect(body.error).toBe("scratchpad_too_large");
      expect(body.limit).toBe(1_000_000);
    } finally {
      await closeServer(server);
    }
  });

  it("PUT /api/scratchpad/blocks/:id returns 413 when updating would push past the size cap", async () => {
    const fixture = createFixture();
    const { server } = await createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const a = await postJson<{ block: { id: string } }>(`${baseUrl}/api/scratchpad/blocks`, { text: "small" });
      const oversize = await fetch(`${baseUrl}/api/scratchpad/blocks/${a.block.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "x".repeat(1_000_001) }),
      });
      expect(oversize.status).toBe(413);
    } finally {
      await closeServer(server);
    }
  });

  it("update_block via MCP returns block on non-empty edit and labels delete with mcp:delete_block source", async () => {
    const fixture = createFixture();
    const { server } = await createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const added = await postJson<{ result: { structuredContent: { block: { id: string } } } }>(
        `${baseUrl}/api/mcp/rpc`,
        {
          jsonrpc: "2.0",
          id: "add",
          method: "tools/call",
          params: { name: "add_block", arguments: { text: "v1" } },
        },
      );
      const id = added.result.structuredContent.block.id;
      const updated = await postJson<{ result: { structuredContent: { block: { id: string; text: string } } } }>(
        `${baseUrl}/api/mcp/rpc`,
        {
          jsonrpc: "2.0",
          id: "up",
          method: "tools/call",
          params: { name: "update_block", arguments: { id, text: "v2" } },
        },
      );
      expect(updated.result.structuredContent.block.id).toBe(id);
      expect(updated.result.structuredContent.block.text).toBe("v2");

      await postJson(`${baseUrl}/api/mcp/rpc`, {
        jsonrpc: "2.0",
        id: "del-via-update",
        method: "tools/call",
        params: { name: "update_block", arguments: { id, text: "" } },
      });
      const list = await getJson<{ entries: Array<{ source: string }> }>(`${baseUrl}/api/scratchpad/history`);
      expect(list.entries[0]?.source).toBe("mcp:delete_block");
    } finally {
      await closeServer(server);
    }
  });

  it("add_block via MCP supports position.afterId and surfaces position_invalid + block_id_required", async () => {
    const fixture = createFixture();
    const { server } = await createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const a = await postJson<{ result: { structuredContent: { block: { id: string } } } }>(`${baseUrl}/api/mcp/rpc`, {
        jsonrpc: "2.0",
        id: "a",
        method: "tools/call",
        params: { name: "add_block", arguments: { text: "a" } },
      });
      await postJson(`${baseUrl}/api/mcp/rpc`, {
        jsonrpc: "2.0",
        id: "c",
        method: "tools/call",
        params: { name: "add_block", arguments: { text: "c" } },
      });
      await postJson(`${baseUrl}/api/mcp/rpc`, {
        jsonrpc: "2.0",
        id: "b",
        method: "tools/call",
        params: {
          name: "add_block",
          arguments: { text: "b", position: { afterId: a.result.structuredContent.block.id } },
        },
      });
      const listed = await postJson<{ result: { structuredContent: { blocks: Array<{ text: string }> } } }>(
        `${baseUrl}/api/mcp/rpc`,
        { jsonrpc: "2.0", id: "ls", method: "tools/call", params: { name: "list_blocks" } },
      );
      expect(listed.result.structuredContent.blocks.map((b) => b.text)).toEqual(["a", "b", "c"]);

      const invalid = await postJson<{ result: { structuredContent: { error: string } } }>(`${baseUrl}/api/mcp/rpc`, {
        jsonrpc: "2.0",
        id: "inv",
        method: "tools/call",
        params: { name: "add_block", arguments: { text: "x", position: { afterId: "" } } },
      });
      expect(invalid.result.structuredContent.error).toBe("position_invalid");

      const updMissing = await postJson<{ result: { structuredContent: { error: string } } }>(
        `${baseUrl}/api/mcp/rpc`,
        {
          jsonrpc: "2.0",
          id: "um",
          method: "tools/call",
          params: { name: "update_block", arguments: { id: "", text: "anything" } },
        },
      );
      expect(updMissing.result.structuredContent.error).toBe("block_id_required");
      const delMissing = await postJson<{ result: { structuredContent: { error: string } } }>(
        `${baseUrl}/api/mcp/rpc`,
        {
          jsonrpc: "2.0",
          id: "dm",
          method: "tools/call",
          params: { name: "delete_block", arguments: { id: "" } },
        },
      );
      expect(delMissing.result.structuredContent.error).toBe("block_id_required");
    } finally {
      await closeServer(server);
    }
  });

  it("PUT /api/scratchpad/blocks/:id with empty text records source ui:delete_block in history", async () => {
    const fixture = createFixture();
    const { server } = await createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const a = await postJson<{ block: { id: string } }>(`${baseUrl}/api/scratchpad/blocks`, { text: "tmp" });
      await putJson(`${baseUrl}/api/scratchpad/blocks/${a.block.id}`, { text: "   " });
      const list = await getJson<{ entries: Array<{ source: string }> }>(`${baseUrl}/api/scratchpad/history`);
      expect(list.entries[0]?.source).toBe("ui:delete_block");
    } finally {
      await closeServer(server);
    }
  });

  it("GET /api/scratchpad/blocks/search returns ranked fuzzy matches", async () => {
    const fixture = createFixture();
    const { server } = await createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      await postJson(`${baseUrl}/api/scratchpad/blocks`, { text: "refine scratchpad MCP" });
      await postJson(`${baseUrl}/api/scratchpad/blocks`, { text: "tmux paste agent launcher" });
      await postJson(`${baseUrl}/api/scratchpad/blocks`, { text: "fuzzy search across cockpit" });
      const search = await getJson<{
        matches: Array<{ block: { id: string; text: string }; score: number; matches: unknown[] }>;
      }>(`${baseUrl}/api/scratchpad/blocks/search?q=fuzzy`);
      expect(search.matches.length).toBeGreaterThan(0);
      expect(search.matches[0]?.block.text).toContain("fuzzy");
    } finally {
      await closeServer(server);
    }
  });

  it("GET /api/scratchpad/blocks/search returns 400 on empty q", async () => {
    const fixture = createFixture();
    const { server } = await createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const response = await fetch(`${baseUrl}/api/scratchpad/blocks/search?q=`);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error?: string };
      expect(body.error).toBe("query_required");
    } finally {
      await closeServer(server);
    }
  });

  it("GET /api/scratchpad/blocks/search clamps limit", async () => {
    const fixture = createFixture();
    const { server } = await createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      await putJson(`${baseUrl}/api/scratchpad`, {
        content: serializeBlocks(
          Array.from({ length: 55 }, (_, i) => ({
            id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
            text: `note ${i} scratchpad item`,
          })),
        ),
      });
      const search = await getJson<{ matches: unknown[] }>(
        `${baseUrl}/api/scratchpad/blocks/search?q=scratchpad&limit=9999`,
      );
      expect(search.matches.length).toBeLessThanOrEqual(50);
    } finally {
      await closeServer(server);
    }
  }, 60_000);
});
