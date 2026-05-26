import { z } from "zod";

// Shared by index.ts and sibling extracted modules (namespaces.ts, ...).
// Lives in its own leaf module so extracted schema files can depend on
// IdSchema without creating a circular import back through index.ts —
// which would TDZ at module-evaluation time.
export const IdSchema = z
  .string()
  .min(2)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9_-]*$/);
