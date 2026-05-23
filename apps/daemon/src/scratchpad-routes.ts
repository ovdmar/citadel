import type { CitadelConfig } from "@citadel/config";
import type express from "express";
import { SCRATCHPAD_MAX_BYTES, readScratchpad, writeScratchpad } from "./scratchpad.js";

type Emit = (type: string, payload: unknown) => void;

export function registerScratchpadRoutes(input: { app: express.Express; config: CitadelConfig; emit: Emit }) {
  const { app, config, emit } = input;

  app.get("/api/scratchpad", (_req, res) => {
    res.json(readScratchpad(config.dataDir));
  });

  app.put("/api/scratchpad", (req, res) => {
    const body = (req.body ?? {}) as { content?: unknown };
    if (typeof body.content !== "string") return res.status(400).json({ error: "content_required" });
    if (Buffer.byteLength(body.content, "utf8") > SCRATCHPAD_MAX_BYTES) {
      return res.status(413).json({ error: "scratchpad_too_large", limit: SCRATCHPAD_MAX_BYTES });
    }
    const snapshot = writeScratchpad(config.dataDir, body.content);
    emit("scratchpad.updated", { updatedAt: snapshot.updatedAt });
    res.json(snapshot);
  });
}
