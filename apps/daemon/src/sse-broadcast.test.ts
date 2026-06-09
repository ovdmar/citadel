import { EventEmitter } from "node:events";
import type { Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { attachSseClientErrorHandler, writeSseEvent } from "./sse-broadcast.js";

describe("writeSseEvent", () => {
  it("drops stale clients instead of failing the caller", () => {
    const live = { write: vi.fn() } as unknown as Response;
    const stale = {
      write: vi.fn(() => {
        throw new Error("stream closed");
      }),
    } as unknown as Response;
    const clients = new Set([stale, live]);
    const detachClient = vi.fn((client: Response) => clients.delete(client));
    const diagnostics = { log: vi.fn() };

    writeSseEvent(clients, "repo.updated", { id: "evt_1" }, detachClient, diagnostics);

    expect(live.write).toHaveBeenCalledWith('event: repo.updated\ndata: {"id":"evt_1"}\n\n');
    expect(detachClient).toHaveBeenCalledWith(stale);
    expect(clients.has(stale)).toBe(false);
    expect(diagnostics.log).toHaveBeenCalledWith("daemon", "sse.write_failed", {
      type: "repo.updated",
      message: "stream closed",
    });
  });

  it("drops clients that are already closed before writing", () => {
    const closed = { destroyed: true, write: vi.fn() } as unknown as Response;
    const clients = new Set([closed]);
    const detachClient = vi.fn((client: Response) => clients.delete(client));
    const diagnostics = { log: vi.fn() };

    writeSseEvent(clients, "repo.updated", { id: "evt_1" }, detachClient, diagnostics);

    expect(closed.write).not.toHaveBeenCalled();
    expect(detachClient).toHaveBeenCalledWith(closed);
    expect(clients.has(closed)).toBe(false);
    expect(diagnostics.log).not.toHaveBeenCalled();
  });

  it("drops clients that emit stream errors asynchronously", () => {
    const client = new EventEmitter() as Response;
    const detachClient = vi.fn();
    const diagnostics = { log: vi.fn() };

    attachSseClientErrorHandler(client, detachClient, diagnostics);
    client.emit("error", new Error("socket reset"));

    expect(detachClient).toHaveBeenCalledWith(client);
    expect(diagnostics.log).toHaveBeenCalledWith("daemon", "sse.client_error", { message: "socket reset" });
  });
});
