import type { CitadelConfig } from "@citadel/config";
import {
  ActionTemplateIdSchema,
  RoleIdSchema,
  UpdateActionTemplateInputSchema,
  UpdateRoleTemplateInputSchema,
} from "@citadel/contracts";
import type express from "express";
import {
  AgentTemplateNotFoundError,
  StaleAgentTemplateUpdatedAtError,
  listAgentTemplates,
  resetActionTemplate,
  resetRoleTemplate,
  updateActionTemplate,
  updateRoleTemplate,
} from "./agent-templates.js";

type Emit = (type: string, payload: unknown) => void;

export function registerAgentTemplateRoutes(input: { app: express.Express; config: CitadelConfig; emit: Emit }) {
  const { app, config, emit } = input;

  app.get("/api/agent-templates", async (_req, res) => {
    const roles = await listAgentTemplates(config.dataDir);
    res.json({ roles });
  });

  app.put("/api/agent-templates/roles/:role", async (req, res) => {
    const role = RoleIdSchema.safeParse(req.params.role);
    const body = UpdateRoleTemplateInputSchema.safeParse(req.body ?? {});
    if (!role.success || !body.success) {
      return res
        .status(400)
        .json({ error: "invalid_input", detail: role.success ? body.error?.message : role.error.message });
    }
    try {
      const updated = await updateRoleTemplate(config.dataDir, role.data, body.data);
      emit("agent-templates.updated", { role: updated.role });
      res.json({ role: updated });
    } catch (error) {
      return mapTemplateError(error, res);
    }
  });

  app.post("/api/agent-templates/roles/:role/reset", async (req, res) => {
    const role = RoleIdSchema.safeParse(req.params.role);
    if (!role.success) return res.status(400).json({ error: "invalid_input", detail: role.error.message });
    try {
      const updated = await resetRoleTemplate(config.dataDir, role.data);
      emit("agent-templates.updated", { role: updated.role });
      res.json({ role: updated });
    } catch (error) {
      return mapTemplateError(error, res);
    }
  });

  app.put("/api/agent-templates/actions/:id", async (req, res) => {
    const id = ActionTemplateIdSchema.safeParse(req.params.id);
    const body = UpdateActionTemplateInputSchema.safeParse(req.body ?? {});
    if (!id.success || !body.success) {
      return res
        .status(400)
        .json({ error: "invalid_input", detail: id.success ? body.error?.message : id.error.message });
    }
    try {
      const action = await updateActionTemplate(config.dataDir, id.data, body.data);
      emit("agent-templates.updated", { actionId: action.id });
      res.json({ action });
    } catch (error) {
      return mapTemplateError(error, res);
    }
  });

  app.post("/api/agent-templates/actions/:id/reset", async (req, res) => {
    const id = ActionTemplateIdSchema.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ error: "invalid_input", detail: id.error.message });
    try {
      const action = await resetActionTemplate(config.dataDir, id.data);
      emit("agent-templates.updated", { actionId: action.id });
      res.json({ action });
    } catch (error) {
      return mapTemplateError(error, res);
    }
  });
}

function mapTemplateError(error: unknown, res: express.Response) {
  if (error instanceof StaleAgentTemplateUpdatedAtError) return res.status(409).json({ error: "stale_updated_at" });
  if (error instanceof AgentTemplateNotFoundError) return res.status(404).json({ error: "agent_template_not_found" });
  throw error;
}
