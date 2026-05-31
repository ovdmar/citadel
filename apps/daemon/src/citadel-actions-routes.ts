// HTTP routes for Citadel Actions (configurable prompt + runtime presets).
// All writes go through the daemon-side mutex declared in `citadel-actions.ts`.
import type { CitadelConfig } from "@citadel/config";
import { CreateCitadelActionInputSchema, UpdateCitadelActionInputSchema } from "@citadel/contracts";
import type express from "express";
import {
  CannotDeleteBuiltInError,
  CitadelActionNotFoundError,
  StaleUpdatedAtError,
  createCitadelAction,
  deleteCitadelAction,
  listCitadelActions,
  resetCitadelAction,
  updateCitadelAction,
} from "./citadel-actions.js";

type Emit = (type: string, payload: unknown) => void;

export function registerCitadelActionRoutes(input: { app: express.Express; config: CitadelConfig; emit: Emit }) {
  const { app, config, emit } = input;

  app.get("/api/citadel-actions", async (_req, res) => {
    const actions = await listCitadelActions(config.dataDir);
    res.json({ actions });
  });

  app.post("/api/citadel-actions", async (req, res) => {
    const parsed = CreateCitadelActionInputSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_input", detail: parsed.error.message });
    }
    const action = await createCitadelAction(config.dataDir, parsed.data);
    emit("citadel-actions.updated", { id: action.id });
    res.status(201).json({ action });
  });

  app.put("/api/citadel-actions/:id", async (req, res) => {
    const parsed = UpdateCitadelActionInputSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_input", detail: parsed.error.message });
    }
    try {
      const action = await updateCitadelAction(config.dataDir, req.params.id, parsed.data);
      emit("citadel-actions.updated", { id: action.id });
      res.json({ action });
    } catch (error) {
      if (error instanceof StaleUpdatedAtError) {
        return res.status(409).json({ error: "stale_updated_at" });
      }
      if (error instanceof CitadelActionNotFoundError) {
        return res.status(404).json({ error: "action_not_found" });
      }
      throw error;
    }
  });

  app.delete("/api/citadel-actions/:id", async (req, res) => {
    try {
      await deleteCitadelAction(config.dataDir, req.params.id);
      emit("citadel-actions.updated", { id: req.params.id });
      res.status(204).end();
    } catch (error) {
      if (error instanceof CannotDeleteBuiltInError) {
        return res.status(409).json({ error: "built_in_action_cannot_be_deleted" });
      }
      if (error instanceof CitadelActionNotFoundError) {
        return res.status(404).json({ error: "action_not_found" });
      }
      throw error;
    }
  });

  app.post("/api/citadel-actions/:id/reset", async (req, res) => {
    try {
      const action = await resetCitadelAction(config.dataDir, req.params.id);
      emit("citadel-actions.updated", { id: action.id });
      res.json({ action });
    } catch (error) {
      if (error instanceof CitadelActionNotFoundError) {
        return res.status(404).json({ error: "action_not_found" });
      }
      throw error;
    }
  });
}
