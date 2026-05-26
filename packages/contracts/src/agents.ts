import { z } from "zod";
import { IdSchema } from "./primitives.js";

export const AgentDefinitionKindSchema = z.enum(["predefined", "custom"]);
export const AgentDefinitionIdSchema = IdSchema;
export const PredefinedAgentKindSchema = z.enum(["implementation", "prototype", "pm", "architect"]);

export const AgentDefinitionSchema = z.object({
  id: AgentDefinitionIdSchema,
  kind: AgentDefinitionKindSchema,
  name: z.string().min(1).max(80),
  systemPrompt: z.string().min(1).max(50_000),
  runtime: z.string().min(1).max(80),
  model: z.string().min(1).max(120).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const CreateAgentDefinitionInputSchema = z.object({
  name: z.string().min(1).max(80),
  systemPrompt: z.string().min(1).max(50_000),
  runtime: z.string().min(1).max(80),
  model: z.string().min(1).max(120).optional(),
});

export const UpdateAgentDefinitionInputSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  systemPrompt: z.string().min(1).max(50_000).optional(),
  runtime: z.string().min(1).max(80).optional(),
  model: z.string().min(1).max(120).nullable().optional(),
});

export const AgentsConfigSchema = z.object({
  defaultRuntime: z.string().min(1).max(80),
});

export const LaunchPredefinedAgentInputSchema = z.object({
  prompt: z.string().min(1),
  workspaceId: IdSchema.optional(),
  repoId: IdSchema.optional(),
  repoName: z.string().min(1).max(80).optional(),
  namespaceId: IdSchema.optional(),
  displayName: z.string().min(1).max(80).optional(),
  workspaceName: z.string().min(1).max(80).optional(),
  branchName: z.string().min(1).max(120).optional(),
});

export const LaunchCustomAgentInputSchema = LaunchPredefinedAgentInputSchema.extend({
  agentId: AgentDefinitionIdSchema,
});

export const RegisterPlanInputSchema = z.object({
  workspaceId: IdSchema,
  path: z.string().min(1).max(4096),
  summary: z.string().max(2000).optional(),
});

export const PlanRegistrationSchema = z.object({
  id: z.string().min(1).max(80),
  workspaceId: IdSchema,
  path: z.string().min(1).max(4096),
  summary: z.string().nullable(),
  registeredAt: z.string(),
  registeredBySessionId: z.string().nullable(),
});

export const LaunchHandoffAgentInputSchema = z
  .object({
    workspaceId: IdSchema,
    planId: z.string().min(1).max(80).optional(),
    predefinedKind: PredefinedAgentKindSchema.optional(),
    customAgentId: AgentDefinitionIdSchema.optional(),
    additionalPrompt: z.string().max(50_000).optional(),
  })
  .refine((value) => (value.predefinedKind !== undefined ? 1 : 0) + (value.customAgentId !== undefined ? 1 : 0) === 1, {
    message: "Exactly one of predefinedKind or customAgentId must be supplied",
    path: ["predefinedKind"],
  });

export const RuntimeModelDescriptorSchema = z.object({
  id: z.string().min(1).max(120),
  displayName: z.string().min(1).max(120).optional(),
  isDefault: z.boolean().optional(),
});

export const RuntimeModelsResponseSchema = z.object({
  models: z.array(RuntimeModelDescriptorSchema),
  probeError: z.string().optional(),
});

export type AgentDefinitionKind = z.infer<typeof AgentDefinitionKindSchema>;
export type AgentDefinitionId = z.infer<typeof AgentDefinitionIdSchema>;
export type PredefinedAgentKind = z.infer<typeof PredefinedAgentKindSchema>;
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;
export type CreateAgentDefinitionInput = z.infer<typeof CreateAgentDefinitionInputSchema>;
export type UpdateAgentDefinitionInput = z.infer<typeof UpdateAgentDefinitionInputSchema>;
export type AgentsConfig = z.infer<typeof AgentsConfigSchema>;
export type LaunchPredefinedAgentInput = z.infer<typeof LaunchPredefinedAgentInputSchema>;
export type LaunchCustomAgentInput = z.infer<typeof LaunchCustomAgentInputSchema>;
export type RegisterPlanInput = z.infer<typeof RegisterPlanInputSchema>;
export type PlanRegistration = z.infer<typeof PlanRegistrationSchema>;
export type LaunchHandoffAgentInput = z.infer<typeof LaunchHandoffAgentInputSchema>;
export type RuntimeModelDescriptor = z.infer<typeof RuntimeModelDescriptorSchema>;
export type RuntimeModelsResponse = z.infer<typeof RuntimeModelsResponseSchema>;
