import type { Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { writeSseEvent } from "./sse-broadcast.js";

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
});
