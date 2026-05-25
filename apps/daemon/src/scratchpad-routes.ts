import type { CitadelConfig } from "@citadel/config";
import type express from "express";
import { findHistoryEntry, listHistorySummaries } from "./scratchpad-history.js";
import { SCRATCHPAD_MAX_BYTES, readScratchpad, writeScratchpad } from "./scratchpad.js";

type Emit = (type: string, payload: unknown) => void;

export function registerScratchpadRoutes(input: { app: express.Express; config: CitadelConfig; emit: Emit }) {
  const { app, config, emit } = input;

  app.get("/api/scratchpad", (_req, res) => {
    res.json(readScratchpad(config.dataDir));
  });

  app.put("/api/scratchpad", (req, res) => {
    const body = (req.body ?? {}) as { content?: unknown; source?: unknown };
    if (typeof body.content !== "string") return res.status(400).json({ error: "content_required" });
    if (body.source !== undefined && body.source !== "ui") {
      return res.status(400).json({ error: "source_forbidden" });
    }
    if (Buffer.byteLength(body.content, "utf8") > SCRATCHPAD_MAX_BYTES) {
      return res.status(413).json({ error: "scratchpad_too_large", limit: SCRATCHPAD_MAX_BYTES });
    }
    const snapshot = writeScratchpad(config.dataDir, body.content, "ui");
    emit("scratchpad.updated", { updatedAt: snapshot.updatedAt });
    emit("scratchpad.history.updated", { updatedAt: snapshot.updatedAt });
    res.json(snapshot);
  });

  app.get("/api/scratchpad/history", (_req, res) => {
    res.json({ entries: listHistorySummaries(config.dataDir) });
  });

  app.get("/api/scratchpad/history/:id", (req, res) => {
    const entry = findHistoryEntry(config.dataDir, req.params.id);
    if (!entry) return res.status(404).json({ error: "history_entry_not_found" });
    res.json({ entry });
  });

  app.post("/api/scratchpad/restore", (req, res) => {
    const body = (req.body ?? {}) as { entryId?: unknown };
    if (typeof body.entryId !== "string" || body.entryId.length === 0) {
      return res.status(400).json({ error: "entry_id_required" });
    }
    const entry = findHistoryEntry(config.dataDir, body.entryId);
    if (!entry) return res.status(404).json({ error: "history_entry_not_found" });
    const snapshot = writeScratchpad(config.dataDir, entry.content, `restore:${entry.id}`);
    emit("scratchpad.updated", { updatedAt: snapshot.updatedAt });
    emit("scratchpad.history.updated", { updatedAt: snapshot.updatedAt });
    res.json(snapshot);
  });
}
