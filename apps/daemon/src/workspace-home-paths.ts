import fs from "node:fs";
import path from "node:path";

export function uniqueWorkspaceRoot(dataDir: string, name: string): string {
  const parent = path.join(dataDir, "structured-workspaces");
  const base = slug(name);
  let candidate = path.join(parent, base);
  for (let index = 2; fs.existsSync(candidate); index += 1) {
    candidate = path.join(parent, `${base}-${index}`);
  }
  return candidate;
}

export function slug(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return normalized || `workspace-${Date.now().toString(36)}`;
}
