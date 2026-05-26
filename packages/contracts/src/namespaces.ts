import { z } from "zod";
import { IdSchema } from "./index.js";

export const NamespaceColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/)
  .nullable()
  .default(null);

export const NamespaceSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(80),
  color: NamespaceColorSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable().default(null),
});

export const CreateNamespaceInputSchema = z.object({
  name: z.string().min(1).max(80),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
});

export const UpdateNamespaceInputSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional(),
});

export const AssignWorkspaceToNamespaceInputSchema = z.object({
  workspaceId: IdSchema,
  namespaceId: IdSchema.nullable(),
});

export type Namespace = z.infer<typeof NamespaceSchema>;
export type CreateNamespaceInput = z.infer<typeof CreateNamespaceInputSchema>;
export type UpdateNamespaceInput = z.infer<typeof UpdateNamespaceInputSchema>;
export type AssignWorkspaceToNamespaceInput = z.infer<typeof AssignWorkspaceToNamespaceInputSchema>;
