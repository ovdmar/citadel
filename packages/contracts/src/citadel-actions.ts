import { z } from "zod";

// Citadel Actions — configurable prompt + preferred-runtime presets surfaced
// in Settings and used by the scratchpad's Refine button (and the
// `refine_scratchpad` MCP tool).
// Storage lives in `<dataDir>/citadel-actions.json`, mutex-serialized.
export const CitadelActionSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().min(1).max(120),
  description: z.string().max(280).default(""),
  icon: z.string().max(40).default(""),
  promptTemplate: z.string().min(1).max(16_000),
  runtimeId: z.string().min(1).max(80).default("claude-code"),
  builtIn: z.boolean().default(false),
  updatedAt: z.string(),
});

export type CitadelAction = z.infer<typeof CitadelActionSchema>;

export const UpdateCitadelActionInputSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(280).optional(),
  icon: z.string().max(40).optional(),
  promptTemplate: z.string().min(1).max(16_000).optional(),
  runtimeId: z.string().min(1).max(80).optional(),
  updatedAt: z.string(),
});

export type UpdateCitadelActionInput = z.infer<typeof UpdateCitadelActionInputSchema>;

export const CreateCitadelActionInputSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(280).default(""),
  icon: z.string().max(40).default(""),
  promptTemplate: z.string().min(1).max(16_000),
  runtimeId: z.string().min(1).max(80).default("claude-code"),
});

export type CreateCitadelActionInput = z.infer<typeof CreateCitadelActionInputSchema>;
