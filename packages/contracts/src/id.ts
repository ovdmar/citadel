import { z } from "zod";

// Shared id schema. Lives in its own leaf module so feature schemas (e.g.,
// scheduled-agents.ts, pr-routes.ts) can import it without creating an ESM
// circular-init hazard with index.ts.
export const IdSchema = z
  .string()
  .min(2)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9_-]*$/);
