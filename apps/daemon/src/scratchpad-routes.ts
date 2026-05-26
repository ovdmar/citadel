// All handlers resolve `effectiveNotesPath(config)` inside the request body —
// `config` is mutated in place by `PUT /api/config` (see app.ts:194), so
// capturing the path in a closure at registration time would silently miss
// runtime updates to `scratchpad.path`.
import { type CitadelConfig, effectiveNotesPath } from "@citadel/config";
import type { ReadScratchpadResult } from "@citadel/contracts";
import type express from "express";
import { findHistoryEntry, listHistorySummaries } from "./scratchpad-history.js";
import {
  SCRATCHPAD_MAX_BYTES,
  addBlock,
  deleteBlock,
  listBlocks,
  parsePosition,
  readScratchpad,
  updateBlock,
  writeScratchpad,
} from "./scratchpad.js";

type Emit = (type: string, payload: unknown) => void;

export function registerScratchpadRoutes(input: { app: express.Express; config: CitadelConfig; emit: Emit }) {
  const { app, config, emit } = input;
  const paths = () => ({ notesPath: effectiveNotesPath(config), dataDir: config.dataDir });

  app.get("/api/scratchpad", (_req, res) => {
    const p = paths();
    const snapshot = readScratchpad(p);
    const body: ReadScratchpadResult = { ...snapshot, path: p.notesPath };
    res.json(body);
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
    const snapshot = writeScratchpad(paths(), body.content, "ui");
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
    const snapshot = writeScratchpad(paths(), entry.content, `restore:${entry.id}`);
    emit("scratchpad.updated", { updatedAt: snapshot.updatedAt });
    emit("scratchpad.history.updated", { updatedAt: snapshot.updatedAt });
    res.json(snapshot);
  });

  app.get("/api/scratchpad/blocks", (_req, res) => {
    res.json(listBlocks(paths()));
  });

  app.post("/api/scratchpad/blocks", (req, res) => {
    const body = (req.body ?? {}) as { text?: unknown; position?: unknown };
    if (typeof body.text !== "string") return res.status(400).json({ error: "text_required" });
    const position = parsePosition(body.position);
    if (position === "invalid") return res.status(400).json({ error: "position_invalid" });
    const result = addBlock(paths(), body.text, position, "ui:add_block");
    if ("error" in result) {
      return res.status(errorStatus(result.error)).json({ error: result.error, ...sizeLimitField(result.error) });
    }
    emit("scratchpad.updated", { updatedAt: result.snapshot.updatedAt });
    emit("scratchpad.history.updated", { updatedAt: result.snapshot.updatedAt });
    res.json({ block: result.block, snapshot: result.snapshot });
  });

  app.put("/api/scratchpad/blocks/:id", (req, res) => {
    const body = (req.body ?? {}) as { text?: unknown };
    if (typeof body.text !== "string") return res.status(400).json({ error: "text_required" });
    const deleting = body.text.trim().length === 0;
    const result = updateBlock(paths(), req.params.id, body.text, deleting ? "ui:delete_block" : "ui:edit_block");
    if ("error" in result) {
      return res.status(errorStatus(result.error)).json({ error: result.error, ...sizeLimitField(result.error) });
    }
    emit("scratchpad.updated", { updatedAt: result.snapshot.updatedAt });
    emit("scratchpad.history.updated", { updatedAt: result.snapshot.updatedAt });
    if ("block" in result) {
      return res.json({ block: result.block, snapshot: result.snapshot });
    }
    res.json({ snapshot: result.snapshot });
  });

  app.delete("/api/scratchpad/blocks/:id", (req, res) => {
    const result = deleteBlock(paths(), req.params.id, "ui:delete_block");
    if ("error" in result) {
      return res.status(errorStatus(result.error)).json({ error: result.error });
    }
    emit("scratchpad.updated", { updatedAt: result.snapshot.updatedAt });
    emit("scratchpad.history.updated", { updatedAt: result.snapshot.updatedAt });
    res.json({ snapshot: result.snapshot });
  });
}

function errorStatus(code: string): number {
  if (code === "block_not_found") return 404;
  if (code === "scratchpad_too_large") return 413;
  return 400;
}

function sizeLimitField(code: string) {
  return code === "scratchpad_too_large" ? { limit: SCRATCHPAD_MAX_BYTES } : {};
}
