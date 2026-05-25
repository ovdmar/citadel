import type { CitadelConfig } from "@citadel/config";
import type { ProviderHealth } from "@citadel/contracts";
import { SEARCH_LIMITS, fuzzySearchBlocks } from "@citadel/core";
import type { SqliteStore } from "@citadel/db";
import type { OperationService } from "@citadel/operations";
import type express from "express";
import { findHistoryEntry, listHistorySummaries } from "./scratchpad-history.js";
import { refineScratchpad } from "./scratchpad-refine.js";
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

export function registerScratchpadRoutes(input: {
  app: express.Express;
  config: CitadelConfig;
  emit: Emit;
  store?: SqliteStore;
  operations?: OperationService;
  providerHealth?: () => Promise<ProviderHealth[]>;
}) {
  const { app, config, emit, store, operations, providerHealth } = input;

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

  app.get("/api/scratchpad/blocks", (_req, res) => {
    res.json(listBlocks(config.dataDir));
  });

  // Fuzzy search over block text. Shares the `fuzzySearchBlocks` core function
  // with the cockpit's floating searchbar so ranking is identical UI ↔ API ↔
  // MCP. Empty q → 400; limit is clamped to [1, SEARCH_LIMITS.max].
  app.get("/api/scratchpad/blocks/search", (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q : "";
    if (q.trim().length === 0) return res.status(400).json({ error: "query_required" });
    const limitRaw = typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : SEARCH_LIMITS.default;
    const limit = Number.isFinite(limitRaw) ? limitRaw : SEARCH_LIMITS.default;
    const { blocks } = listBlocks(config.dataDir);
    const matches = fuzzySearchBlocks(blocks, q, limit);
    res.json({ matches });
  });

  app.post("/api/scratchpad/blocks", (req, res) => {
    const body = (req.body ?? {}) as { text?: unknown; position?: unknown };
    if (typeof body.text !== "string") return res.status(400).json({ error: "text_required" });
    const position = parsePosition(body.position);
    if (position === "invalid") return res.status(400).json({ error: "position_invalid" });
    const result = addBlock(config.dataDir, body.text, position, "ui:add_block");
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
    const result = updateBlock(
      config.dataDir,
      req.params.id,
      body.text,
      deleting ? "ui:delete_block" : "ui:edit_block",
    );
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
    const result = deleteBlock(config.dataDir, req.params.id, "ui:delete_block");
    if ("error" in result) {
      return res.status(errorStatus(result.error)).json({ error: result.error });
    }
    emit("scratchpad.updated", { updatedAt: result.snapshot.updatedAt });
    emit("scratchpad.history.updated", { updatedAt: result.snapshot.updatedAt });
    res.json({ snapshot: result.snapshot });
  });

  // Refine scratchpad — launches an agent with the saved Citadel Action prompt
  // (or an override). Full degradation matrix lives in `scratchpad-refine.ts`.
  // Requires store + operations + providerHealth — only registered when the
  // caller supplied them (vitest fixtures that don't need refine can omit).
  if (store && operations && providerHealth) {
    app.post("/api/scratchpad/refine", async (req, res) => {
      const body = (req.body ?? {}) as { repoId?: unknown; repoName?: unknown; prompt?: unknown };
      const input: { repoId?: string; repoName?: string; prompt?: string } = {};
      if (typeof body.repoId === "string") input.repoId = body.repoId;
      if (typeof body.repoName === "string") input.repoName = body.repoName;
      if (typeof body.prompt === "string") input.prompt = body.prompt;
      const result = await refineScratchpad({ config, store, operations, providerHealth }, input);
      if (result.ok) {
        emit("workspace.updated", { workspaceId: result.workspaceId, operationId: result.operationId });
        if (result.sessionId) emit("agent.updated", { workspaceId: result.workspaceId, sessionId: result.sessionId });
        return res.json(result);
      }
      const status = result.error === "launch_failed" ? 502 : 400;
      res.status(status).json(result);
    });
  }
}

function errorStatus(code: string): number {
  if (code === "block_not_found") return 404;
  if (code === "scratchpad_too_large") return 413;
  return 400;
}

function sizeLimitField(code: string) {
  return code === "scratchpad_too_large" ? { limit: SCRATCHPAD_MAX_BYTES } : {};
}
