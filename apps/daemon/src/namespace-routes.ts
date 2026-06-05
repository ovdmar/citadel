import {
  AssignWorkspaceToNamespaceInputSchema,
  CreateNamespaceInputSchema,
  ReorderNamespacesInputSchema,
  UpdateNamespaceInputSchema,
} from "@citadel/contracts";
import type { SqliteStore } from "@citadel/db";
import type { OperationService } from "@citadel/operations";
import type express from "express";

export type NamespaceRoutesDeps = {
  app: express.Express;
  store: SqliteStore;
  operations: OperationService;
  emit: (type: string, payload: unknown) => void;
  asyncRoute: (
    handler: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<unknown>,
  ) => express.RequestHandler;
};

export function registerNamespaceRoutes(deps: NamespaceRoutesDeps) {
  const { app, store, operations, emit, asyncRoute } = deps;

  app.get("/api/namespaces", (req, res) => {
    const includeArchived = req.query.includeArchived === "true";
    res.json({ namespaces: store.listNamespaces(includeArchived) });
  });

  app.post(
    "/api/namespaces",
    asyncRoute(async (req, res) => {
      const input = CreateNamespaceInputSchema.parse(req.body);
      const result = operations.createNamespace(input);
      emit("namespace.updated", { namespaceId: result.namespace.id });
      res.status(result.created ? 201 : 200).json({ namespace: result.namespace, created: result.created });
    }),
  );

  app.post(
    "/api/namespaces/:namespaceId/restore",
    asyncRoute(async (req, res) => {
      const namespaceId = String(req.params.namespaceId);
      const namespace = operations.restoreNamespace(namespaceId);
      if (!namespace) return res.status(404).json({ error: "namespace_not_found" });
      emit("namespace.updated", { namespaceId });
      res.json({ namespace });
    }),
  );

  app.patch(
    "/api/namespaces/:namespaceId",
    asyncRoute(async (req, res) => {
      const namespaceId = String(req.params.namespaceId);
      const input = UpdateNamespaceInputSchema.parse(req.body);
      if (input.name === undefined && input.color === undefined) {
        return res.status(400).json({ error: "empty_patch" });
      }
      const namespace = operations.renameNamespace(namespaceId, input);
      if (!namespace) return res.status(404).json({ error: "namespace_not_found" });
      emit("namespace.updated", { namespaceId });
      res.json({ namespace });
    }),
  );

  app.delete(
    "/api/namespaces/:namespaceId",
    asyncRoute(async (req, res) => {
      const namespaceId = String(req.params.namespaceId);
      const namespace = operations.archiveNamespace(namespaceId);
      if (!namespace) return res.status(404).json({ error: "namespace_not_found" });
      emit("namespace.updated", { namespaceId });
      res.status(202).json({ namespace });
    }),
  );

  app.post(
    "/api/namespaces/reorder",
    asyncRoute(async (req, res) => {
      const input = ReorderNamespacesInputSchema.parse(req.body);
      const result = operations.reorderNamespaces(input);
      if (!result.reordered) {
        const status = result.reason === "namespace_not_found" ? 404 : 409;
        return res.status(status).json(result);
      }
      emit("namespace.updated", { namespaceIds: input.namespaceIds });
      res.json(result);
    }),
  );

  app.post(
    "/api/namespaces/assign",
    asyncRoute(async (req, res) => {
      const input = AssignWorkspaceToNamespaceInputSchema.parse(req.body);
      const result = operations.assignWorkspaceToNamespace(input);
      if (!result.assigned) {
        const status = result.reason === "namespace_archived" ? 409 : 404;
        return res.status(status).json(result);
      }
      emit("namespace.updated", { workspaceId: input.workspaceId, namespaceId: input.namespaceId });
      emit("workspace.updated", { workspaceId: input.workspaceId });
      res.json(result);
    }),
  );
}
