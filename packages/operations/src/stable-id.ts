import { createHash } from "node:crypto";

export function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24)}`;
}
