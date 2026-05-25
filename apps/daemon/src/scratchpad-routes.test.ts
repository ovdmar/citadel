import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "@citadel/config";
import { SqliteStore } from "@citadel/db";
import { afterEach, describe, expect, it } from "vitest";
import { createDaemonApp } from "./app.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

process.env.CITADEL_DISABLE_REAPER = "1";

describe("scratchpad HTTP + MCP routes", () => {
  it("round-trips content via GET and PUT /api/scratchpad", async () => {
    const fixture = createFixture();
    const { server } = createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const initial = await getJson<{ content: string; updatedAt: string }>(`${baseUrl}/api/scratchpad`);
      expect(initial.content).toContain("Scratchpad");
      expect(initial.updatedAt).toMatch(/T.*Z$/);

      const next = await putJson<{ content: string; updatedAt: string }>(`${baseUrl}/api/scratchpad`, {
        content: "remember to ship",
      });
      expect(next.content).toBe("remember to ship");

      const refetch = await getJson<{ content: string }>(`${baseUrl}/api/scratchpad`);
      expect(refetch.content).toBe("remember to ship");
    } finally {
      await closeServer(server);
    }
  });

  it("PUTs issued in series leave the last writer's content on disk", async () => {
    // Mirrors the cockpit's single-flight save loop: even if a client fires
    // back-to-back PUTs, the final disk state must match the final body —
    // catches regressions where an out-of-order write would clobber the latest.
    const fixture = createFixture();
    const { server } = createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const bodies = ["one", "two", "three", "four", "five"];
      for (const content of bodies) {
        await putJson(`${baseUrl}/api/scratchpad`, { content });
      }
      const final = await getJson<{ content: string }>(`${baseUrl}/api/scratchpad`);
      expect(final.content).toBe("five");
    } finally {
      await closeServer(server);
    }
  });

  it("rejects PUT bodies that try to spoof a non-ui source", async () => {
    const fixture = createFixture();
    const { server } = createDaemonApp(fixture);
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
    const { server } = createDaemonApp(fixture);
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
      // Newest-first ordering: ui (third), mcp:append, mcp:write, ui (first).
      const sources = list.entries.map((entry) => entry.source);
      expect(sources.slice(0, 4)).toEqual(["ui", "mcp:append_scratchpad", "mcp:write_scratchpad", "ui"]);

      const oldest = list.entries[list.entries.length - 1];
      if (!oldest) throw new Error("expected history entries");
      const full = await getJson<{ entry: { id: string; content: string } }>(
        `${baseUrl}/api/scratchpad/history/${oldest.id}`,
      );
      expect(full.entry.id).toBe(oldest.id);
      expect(typeof full.entry.content).toBe("string");

      const restored = await postJson<{ content: string }>(`${baseUrl}/api/scratchpad/restore`, {
        entryId: oldest.id,
      });
      expect(restored.content).toBe(full.entry.content);
      const current = await getJson<{ content: string }>(`${baseUrl}/api/scratchpad`);
      expect(current.content).toBe(full.entry.content);

      const after = await getJson<{ entries: Array<{ source: string }> }>(`${baseUrl}/api/scratchpad/history`);
      expect(after.entries[0]?.source).toBe(`restore:${oldest.id}`);

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
    const { server } = createDaemonApp(fixture);
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

    const { server: server2 } = createDaemonApp(fixture);
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
    const { server } = createDaemonApp(fixture);
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
    const { server } = createDaemonApp(fixture);
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
      expect(read.result.structuredContent.content).toBe("via mcp");

      const appended = await postJson<{ result: { structuredContent: { content: string } } }>(
        `${baseUrl}/api/mcp/rpc`,
        {
          jsonrpc: "2.0",
          id: "append",
          method: "tools/call",
          params: { name: "append_scratchpad", arguments: { content: "more" } },
        },
      );
      expect(appended.result.structuredContent.content).toBe("via mcp\n\nmore\n");

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
    const { server } = createDaemonApp(fixture);
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

type SseEvent = { type: string; payload: { updatedAt?: string } };

async function openHistorySseListener(baseUrl: string) {
  const response = await fetch(`${baseUrl}/events`, { headers: { Accept: "text/event-stream" } });
  if (!response.ok || !response.body) throw new Error("sse_open_failed");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: SseEvent[] = [];
  let buffer = "";
  let closed = false;
  let pendingType: string | null = null;
  const consume = async () => {
    while (!closed) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const newlineIdx = buffer.indexOf("\n");
        if (newlineIdx < 0) break;
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (line.startsWith("event: ")) pendingType = line.slice("event: ".length);
        else if (line.startsWith("data: ") && pendingType === "scratchpad.history.updated") {
          try {
            const parsed = JSON.parse(line.slice("data: ".length)) as SseEvent;
            events.push({ type: pendingType, payload: parsed.payload ?? {} });
          } catch {
            /* ignore malformed */
          }
        }
        if (line === "") pendingType = null;
      }
    }
  };
  consume().catch(() => {
    /* stream closed */
  });
  return {
    async waitFor(count: number, timeoutMs: number) {
      const start = Date.now();
      while (events.length < count) {
        if (Date.now() - start > timeoutMs) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return events.slice();
    },
    close() {
      closed = true;
      reader.cancel().catch(() => {
        /* already closed */
      });
    },
  };
}

function createFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-scratchpad-routes-"));
  dirs.push(dir);
  const configPath = path.join(dir, "citadel.config.json");
  const config = loadConfig(configPath);
  config.dataDir = dir;
  config.databasePath = path.join(dir, "citadel.sqlite");
  config.providers = {
    github: { enabled: false, command: "gh" },
    jira: { enabled: false, command: "jtk" },
  };
  config.runtimes = [{ id: "shell", displayName: "Shell", command: "bash", args: ["-l"] }];
  const store = new SqliteStore(config.databasePath);
  store.migrate();
  return { config, configPath, store };
}

function listen(server: http.Server) {
  return new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP test server address");
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function closeServer(server: http.Server) {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function getJson<T>(url: string) {
  const response = await fetch(url);
  expect(response.ok).toBe(true);
  return response.json() as Promise<T>;
}

async function putJson<T>(url: string, body: unknown) {
  const response = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.clone().text();
  expect(response.ok, text).toBe(true);
  return response.json() as Promise<T>;
}

async function postJson<T>(url: string, body: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.clone().text();
  expect(response.ok, text).toBe(true);
  return response.json() as Promise<T>;
}
