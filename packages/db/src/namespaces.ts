import type { Namespace } from "@citadel/contracts";

type Statement = {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number };
};

type Database = {
  prepare(sql: string): Statement;
};

function asString(row: Record<string, unknown>, key: string) {
  return String(row[key] ?? "");
}

export function namespaceFromRow(row: Record<string, unknown>): Namespace {
  return {
    id: asString(row, "id"),
    name: asString(row, "name"),
    color: row.color ? asString(row, "color") : null,
    position: Number(row.position ?? 0),
    createdAt: asString(row, "created_at"),
    updatedAt: asString(row, "updated_at"),
    archivedAt: row.archived_at ? asString(row, "archived_at") : null,
  };
}

export function listNamespaces(db: Database, includeArchived = false): Namespace[] {
  const sql = includeArchived
    ? "SELECT * FROM namespaces ORDER BY position, name"
    : "SELECT * FROM namespaces WHERE archived_at IS NULL ORDER BY position, name";
  return db
    .prepare(sql)
    .all()
    .map((row) => namespaceFromRow(row as Record<string, unknown>));
}

export function findNamespace(db: Database, id: string): Namespace | null {
  const row = db.prepare("SELECT * FROM namespaces WHERE id = ?").get(id);
  if (!row) return null;
  return namespaceFromRow(row as Record<string, unknown>);
}

export function findNamespaceByName(db: Database, name: string): Namespace | null {
  const row = db.prepare("SELECT * FROM namespaces WHERE name = ?").get(name);
  if (!row) return null;
  return namespaceFromRow(row as Record<string, unknown>);
}

export function insertNamespace(db: Database, namespace: Namespace) {
  db.prepare(
    `INSERT INTO namespaces (id, name, color, position, created_at, updated_at, archived_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    namespace.id,
    namespace.name,
    namespace.color ?? null,
    namespace.position,
    namespace.createdAt,
    namespace.updatedAt,
    namespace.archivedAt ?? null,
  );
}

export function updateNamespace(
  db: Database,
  id: string,
  patch: Partial<Pick<Namespace, "name" | "color">>,
): Namespace | null {
  const existing = findNamespace(db, id);
  if (!existing) return null;
  const next: Namespace = {
    ...existing,
    name: patch.name ?? existing.name,
    color: patch.color !== undefined ? patch.color : existing.color,
    updatedAt: new Date().toISOString(),
  };
  db.prepare("UPDATE namespaces SET name = ?, color = ?, updated_at = ? WHERE id = ?").run(
    next.name,
    next.color ?? null,
    next.updatedAt,
    id,
  );
  return next;
}

export function archiveNamespace(db: Database, id: string): Namespace | null {
  const existing = findNamespace(db, id);
  if (!existing) return null;
  const now = new Date().toISOString();
  db.prepare("UPDATE namespaces SET archived_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);
  db.prepare("UPDATE workspaces SET namespace_id = NULL, updated_at = ? WHERE namespace_id = ?").run(now, id);
  return { ...existing, archivedAt: now, updatedAt: now };
}

export function restoreNamespace(db: Database, id: string, patch: { color?: string | null } = {}): Namespace | null {
  const existing = findNamespace(db, id);
  if (!existing) return null;
  const now = new Date().toISOString();
  const color = patch.color !== undefined ? patch.color : existing.color;
  db.prepare("UPDATE namespaces SET archived_at = NULL, color = ?, updated_at = ? WHERE id = ?").run(
    color ?? null,
    now,
    id,
  );
  return { ...existing, color, archivedAt: null, updatedAt: now };
}

export function reorderNamespaces(db: Database, namespaceIds: readonly string[]): Namespace[] {
  const now = new Date().toISOString();
  const update = db.prepare("UPDATE namespaces SET position = ?, updated_at = ? WHERE id = ?");
  const activeIds = new Set(listNamespaces(db).map((namespace) => namespace.id));
  db.prepare("BEGIN").run();
  try {
    for (const [index, id] of namespaceIds.entries()) {
      if (!activeIds.has(id)) continue;
      update.run((index + 1) * 1024, now, id);
    }
    db.prepare("COMMIT").run();
  } catch (err) {
    db.prepare("ROLLBACK").run();
    throw err;
  }
  return listNamespaces(db);
}

export function setWorkspaceNamespace(db: Database, workspaceId: string, namespaceId: string | null): boolean {
  const now = new Date().toISOString();
  const result = db
    .prepare("UPDATE workspaces SET namespace_id = ?, updated_at = ? WHERE id = ?")
    .run(namespaceId, now, workspaceId);
  return result.changes > 0;
}
