import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDaemonApp } from "./app.js";
import { parseBlocks } from "./scratchpad-blocks.js";
import {
  closeServer,
  createScratchpadFixture,
  getJson,
  listen,
  openHistorySseListener,
  postJson,
  putJson,
} from "./scratchpad-routes.test-utils.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

process.env.CITADEL_DISABLE_REAPER = "1";

const createFixture = () => createScratchpadFixture(dirs);

describe("scratchpad HTTP + MCP routes", () => {
  it("round-trips content via GET and PUT /api/scratchpad", async () => {
    const fixture = createFixture();
    const { server } = await createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const initial = await getJson<{ content: string; updatedAt: string }>(`${baseUrl}/api/scratchpad`);
      expect(initial.content).toContain("Scratchpad");
      expect(initial.updatedAt).toMatch(/T.*Z$/);

      const next = await putJson<{ content: string; updatedAt: string }>(`${baseUrl}/api/scratchpad`, {
        content: "remember to ship",
      });
      expect(next.content).toBe("remember to ship");

      // GET runs migrateIfNeeded; legacy plain text becomes a fenced block.
      const refetch = await getJson<{ content: string }>(`${baseUrl}/api/scratchpad`);
      expect(parseBlocks(refetch.content).blocks.map((b) => b.text)).toEqual(["remember to ship"]);
    } finally {
      await closeServer(server);
    }
  });

  it("PUTs issued in series leave the last writer's content on disk", async () => {
    // Mirrors the cockpit's single-flight save loop: even if a client fires
    // back-to-back PUTs, the final disk state must match the final body —
    // catches regressions where an out-of-order write would clobber the latest.
    const fixture = createFixture();
    const { server } = await createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const bodies = ["one", "two", "three", "four", "five"];
      for (const content of bodies) {
        await putJson(`${baseUrl}/api/scratchpad`, { content });
      }
      // GET migrates the legacy content; the final block carries the last writer's text.
      const final = await getJson<{ content: string }>(`${baseUrl}/api/scratchpad`);
      const blocks = parseBlocks(final.content).blocks;
      expect(blocks.map((b) => b.text)).toEqual(["five"]);
    } finally {
      await closeServer(server);
    }
  });

  it("rejects PUT bodies that try to spoof a non-ui source", async () => {
    const fixture = createFixture();
    const { server } = await createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const response = await fetch(`${baseUrl}/api/scratchpad`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "spoof", source: "mcp:write_scratchpad" }),
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("source_forbidden");
    } finally {
      await closeServer(server);
    }
  });

  it("exposes scratchpad history and supports restore", async () => {
    const fixture = createFixture();
    const { server } = await createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      await putJson(`${baseUrl}/api/scratchpad`, { content: "first" });
      // Different source ensures a new entry, not a coalesced one.
      await postJson(`${baseUrl}/api/mcp/rpc`, {
        jsonrpc: "2.0",
        id: "w",
        method: "tools/call",
        params: { name: "write_scratchpad", arguments: { content: "second from mcp" } },
      });
      // Drive append_scratchpad too so its source label is exercised end-to-end.
      await postJson(`${baseUrl}/api/mcp/rpc`, {
        jsonrpc: "2.0",
        id: "a",
        method: "tools/call",
        params: { name: "append_scratchpad", arguments: { content: "tail" } },
      });
      await putJson(`${baseUrl}/api/scratchpad`, { content: "third" });

      const list = await getJson<{ entries: Array<{ id: string; source: string; preview: string; content?: string }> }>(
        `${baseUrl}/api/scratchpad/history`,
      );
      expect(list.entries.length).toBeGreaterThanOrEqual(4);
      expect(list.entries[0]?.source).toBe("ui");
      for (const entry of list.entries) {
        expect(entry.content).toBeUndefined();
        expect(typeof entry.preview).toBe("string");
      }
      // Newest-first ordering. Each non-fenced write produces a migrate-to-blocks
      // entry on the next read; the cockpit's PUT-then-MCP sequence interleaves
      // those entries with the writer's sources.
      const sources = list.entries.map((entry) => entry.source);
      expect(sources).toContain("ui");
      expect(sources).toContain("mcp:write_scratchpad");
      expect(sources).toContain("mcp:append_scratchpad");
      expect(sources).toContain("migrate-to-blocks");

      const oldest = list.entries[list.entries.length - 1];
      if (!oldest) throw new Error("expected history entries");
      const full = await getJson<{ entry: { id: string; content: string } }>(
        `${baseUrl}/api/scratchpad/history/${oldest.id}`,
      );
      expect(full.entry.id).toBe(oldest.id);
      expect(typeof full.entry.content).toBe("string");

      // Restore returns the exact bytes of the snapshot (writeScratchpad is byte-faithful).
      const restored = await postJson<{ content: string }>(`${baseUrl}/api/scratchpad/restore`, {
        entryId: oldest.id,
      });
      expect(restored.content).toBe(full.entry.content);
      // GET /api/scratchpad now re-runs migrateIfNeeded over the restored content;
      // if it was legacy (pre-migration) it gets re-fenced, so we check semantics
      // (block texts match) rather than exact bytes.
      const current = await getJson<{ content: string }>(`${baseUrl}/api/scratchpad`);
      const restoredBlocks = parseBlocks(full.entry.content).blocks;
      const currentBlocks = parseBlocks(current.content).blocks;
      if (restoredBlocks.length > 0) {
        expect(currentBlocks.map((b) => b.text)).toEqual(restoredBlocks.map((b) => b.text));
      } else {
        // Pre-migration legacy text — confirm the migrated block carries the same text.
        expect(currentBlocks.map((b) => b.text).join("\n\n")).toContain(full.entry.content.trim());
      }

      const after = await getJson<{ entries: Array<{ source: string }> }>(`${baseUrl}/api/scratchpad/history`);
      // The restore source is present; if the restored snapshot was legacy, a
      // subsequent migrate-to-blocks entry may also be present and newer.
      const sourcesAfter = after.entries.map((e) => e.source);
      expect(sourcesAfter).toContain(`restore:${oldest.id}`);

      const missing = await fetch(`${baseUrl}/api/scratchpad/history/nope`);
      expect(missing.status).toBe(404);
      const badRestore = await fetch(`${baseUrl}/api/scratchpad/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entryId: "nope" }),
      });
      expect(badRestore.status).toBe(404);
    } finally {
      await closeServer(server);
    }
  });

  it("backfills pre-existing scratchpad content on first boot only", async () => {
    const fixture = createFixture();
    const spPath = path.join(fixture.config.dataDir, "scratchpad.md");
    fs.writeFileSync(spPath, "pre-existing notes");
    const { server } = await createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const list = await getJson<{ entries: Array<{ source: string; preview: string }> }>(
        `${baseUrl}/api/scratchpad/history`,
      );
      expect(list.entries).toHaveLength(1);
      expect(list.entries[0]?.source).toBe("backfill");
      expect(list.entries[0]?.preview).toBe("pre-existing notes");
    } finally {
      await closeServer(server);
    }

    const { server: server2 } = await createDaemonApp(fixture);
    const baseUrl2 = await listen(server2);
    try {
      const list = await getJson<{ entries: unknown[] }>(`${baseUrl2}/api/scratchpad/history`);
      expect(list.entries).toHaveLength(1);
    } finally {
      await closeServer(server2);
    }
  });

  it("rejects oversize PUT bodies", async () => {
    const fixture = createFixture();
    const { server } = await createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const tooLarge = "x".repeat(1_000_001);
      const response = await fetch(`${baseUrl}/api/scratchpad`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: tooLarge }),
      });
      expect(response.status).toBe(413);
    } finally {
      await closeServer(server);
    }
  });

  it("exposes read_scratchpad and write_scratchpad through MCP", async () => {
    const fixture = createFixture();
    const { server } = await createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const list = await postJson<{ result: { tools: Array<{ name: string }> } }>(`${baseUrl}/api/mcp/rpc`, {
        jsonrpc: "2.0",
        id: "list",
        method: "tools/list",
      });
      const toolNames = list.result.tools.map((tool) => tool.name);
      expect(toolNames).toEqual(expect.arrayContaining(["read_scratchpad", "write_scratchpad", "append_scratchpad"]));

      const write = await postJson<{ result: { structuredContent: { content: string } } }>(`${baseUrl}/api/mcp/rpc`, {
        jsonrpc: "2.0",
        id: "write",
        method: "tools/call",
        params: { name: "write_scratchpad", arguments: { content: "via mcp" } },
      });
      expect(write.result.structuredContent.content).toBe("via mcp");

      const read = await postJson<{ result: { structuredContent: { content: string } } }>(`${baseUrl}/api/mcp/rpc`, {
        jsonrpc: "2.0",
        id: "read",
        method: "tools/call",
        params: { name: "read_scratchpad" },
      });
      // read_scratchpad triggers migrateIfNeeded; legacy plain-text becomes a fenced block.
      expect(parseBlocks(read.result.structuredContent.content).blocks.map((b) => b.text)).toEqual(["via mcp"]);

      const appended = await postJson<{ result: { structuredContent: { content: string } } }>(
        `${baseUrl}/api/mcp/rpc`,
        {
          jsonrpc: "2.0",
          id: "append",
          method: "tools/call",
          params: { name: "append_scratchpad", arguments: { content: "more" } },
        },
      );
      // append_scratchpad now creates a new fenced block per call — verify both
      // the prior 'via mcp' content and the appended 'more' survive as blocks.
      const appendedContent = appended.result.structuredContent.content;
      expect(appendedContent).toMatch(/<!-- block:[0-9a-f-]{36} -->\nvia mcp\n<!-- \/block:/);
      expect(appendedContent).toMatch(/<!-- block:[0-9a-f-]{36} -->\nmore\n<!-- \/block:/);

      // Oversize writes return a structured sentinel rather than throwing, so
      // an orchestrator agent can branch on { error } instead of catching a
      // JSON-RPC error envelope.
      const oversize = await postJson<{ result: { structuredContent: { error: string; limit: number } } }>(
        `${baseUrl}/api/mcp/rpc`,
        {
          jsonrpc: "2.0",
          id: "oversize",
          method: "tools/call",
          params: { name: "write_scratchpad", arguments: { content: "x".repeat(1_000_001) } },
        },
      );
      expect(oversize.result.structuredContent).toMatchObject({ error: "scratchpad_too_large", limit: 1_000_000 });

      // write_scratchpad without a content string returns the same structured
      // sentinel shape rather than triggering a generic JSON-RPC error.
      const missing = await postJson<{ result: { structuredContent: { error: string } } }>(`${baseUrl}/api/mcp/rpc`, {
        jsonrpc: "2.0",
        id: "missing",
        method: "tools/call",
        params: { name: "write_scratchpad", arguments: {} },
      });
      expect(missing.result.structuredContent).toMatchObject({ error: "content_required" });

      // append_scratchpad with an empty content string is also content_required:
      // appends with zero bytes are a no-op the agent probably didn't mean to make.
      const emptyAppend = await postJson<{ result: { structuredContent: { error: string } } }>(
        `${baseUrl}/api/mcp/rpc`,
        {
          jsonrpc: "2.0",
          id: "empty-append",
          method: "tools/call",
          params: { name: "append_scratchpad", arguments: { content: "" } },
        },
      );
      expect(emptyAppend.result.structuredContent).toMatchObject({ error: "content_required" });
    } finally {
      await closeServer(server);
    }
  });

  it("emits scratchpad.history.updated on every mutation path", async () => {
    const fixture = createFixture();
    const { server } = await createDaemonApp(fixture);
    const baseUrl = await listen(server);
    const listener = await openHistorySseListener(baseUrl);
    try {
      await putJson(`${baseUrl}/api/scratchpad`, { content: "via put" });
      await postJson(`${baseUrl}/api/mcp/rpc`, {
        jsonrpc: "2.0",
        id: "mw",
        method: "tools/call",
        params: { name: "write_scratchpad", arguments: { content: "via mcp write" } },
      });
      await postJson(`${baseUrl}/api/mcp/rpc`, {
        jsonrpc: "2.0",
        id: "ma",
        method: "tools/call",
        params: { name: "append_scratchpad", arguments: { content: "tail" } },
      });
      const list = await getJson<{ entries: Array<{ id: string }> }>(`${baseUrl}/api/scratchpad/history`);
      const oldest = list.entries[list.entries.length - 1];
      if (!oldest) throw new Error("expected an entry to restore");
      await postJson(`${baseUrl}/api/scratchpad/restore`, { entryId: oldest.id });

      const events = await listener.waitFor(4, 2_000);
      expect(events).toHaveLength(4);
      // Every event has an updatedAt timestamp.
      for (const event of events) expect(typeof event.payload?.updatedAt).toBe("string");
    } finally {
      listener.close();
      await closeServer(server);
    }
  });
});

describe("configurable notes location — HTTP + MCP routes", () => {
  it("GET /api/scratchpad includes the absolute path field, matching effectiveNotesPath(config)", async () => {
    const fixture = createFixture();
    const { server } = await createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const body = await getJson<{ content: string; updatedAt: string; path: string }>(`${baseUrl}/api/scratchpad`);
      expect(typeof body.path).toBe("string");
      expect(path.isAbsolute(body.path)).toBe(true);
      // Default location is `<dataDir>/scratchpad.md` when no override is set.
      expect(body.path).toBe(path.join(fixture.config.dataDir, "scratchpad.md"));
    } finally {
      await closeServer(server);
    }
  });

  it("honors scratchpad.path set via PUT /api/config mid-session, without daemon restart", async () => {
    const fixture = createFixture();
    const { server } = await createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const customNotes = path.join(fixture.config.dataDir, "synced", "custom-notes.md");
      // Patch the config through the live HTTP endpoint — proves handlers
      // re-resolve effectiveNotesPath(config) per request rather than capturing
      // it at registration.
      await putJson(`${baseUrl}/api/config`, { scratchpad: { path: customNotes } });
      const body = await getJson<{ path: string }>(`${baseUrl}/api/scratchpad`);
      expect(body.path).toBe(customNotes);

      // And clearing it falls back to the default.
      await putJson(`${baseUrl}/api/config`, { scratchpad: {} });
      const back = await getJson<{ path: string }>(`${baseUrl}/api/scratchpad`);
      expect(back.path).toBe(path.join(fixture.config.dataDir, "scratchpad.md"));
    } finally {
      await closeServer(server);
    }
  });

  it("PUT /api/scratchpad and block routes do NOT include path in their response (narrow internal type preserved)", async () => {
    const fixture = createFixture();
    const { server } = await createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const putBody = await putJson<Record<string, unknown>>(`${baseUrl}/api/scratchpad`, { content: "x" });
      expect(putBody).not.toHaveProperty("path");
      expect(putBody).toHaveProperty("content");
      expect(putBody).toHaveProperty("updatedAt");

      const postBody = await postJson<{ block: Record<string, unknown>; snapshot: Record<string, unknown> }>(
        `${baseUrl}/api/scratchpad/blocks`,
        { text: "hello" },
      );
      expect(postBody.snapshot).not.toHaveProperty("path");
      expect(postBody.block).not.toHaveProperty("path");
    } finally {
      await closeServer(server);
    }
  });

  it("read_scratchpad MCP dispatch returns { content, updatedAt, path }", async () => {
    const fixture = createFixture();
    const { server } = await createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const result = await postJson<{
        result: { structuredContent: { content: string; updatedAt: string; path: string } };
      }>(`${baseUrl}/api/mcp/rpc`, {
        jsonrpc: "2.0",
        id: "rs",
        method: "tools/call",
        params: { name: "read_scratchpad", arguments: {} },
      });
      const sc = result.result.structuredContent;
      expect(typeof sc.content).toBe("string");
      expect(typeof sc.updatedAt).toBe("string");
      expect(sc.path).toBe(path.join(fixture.config.dataDir, "scratchpad.md"));
    } finally {
      await closeServer(server);
    }
  });

  it("inspect_status MCP response includes scratchpad.path", async () => {
    const fixture = createFixture();
    const { server } = await createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const result = await postJson<{
        result: { structuredContent: { scratchpad: { path: string } } };
      }>(`${baseUrl}/api/mcp/rpc`, {
        jsonrpc: "2.0",
        id: "is",
        method: "tools/call",
        params: { name: "inspect_status", arguments: {} },
      });
      expect(result.result.structuredContent.scratchpad).toEqual({
        path: path.join(fixture.config.dataDir, "scratchpad.md"),
      });
    } finally {
      await closeServer(server);
    }
  });
});
