import { z } from "zod";

// Resolution for the file-based teardown hook (`.citadel/hooks/teardown`).
//
// Asymmetry vs DeployHookResolution: there is no "repo-config" source here.
// Configured teardown hooks live in `repo.teardownHookIds` and are resolved
// separately by the hooks runner in `packages/operations`. Both paths are
// executed in `removeWorkspace` — file first, then configured — but this
// resolution covers only the file-based discovery step.
export const TeardownHookSourceSchema = z.enum(["repo-file", "none"]);

export const TeardownHookResolutionSchema = z.object({
  source: TeardownHookSourceSchema,
  filePath: z.string().nullable().default(null),
  // Diagnostic breadcrumb — e.g. "<path> exists but is not executable".
  note: z.string().nullable().default(null),
});

export type TeardownHookResolution = z.infer<typeof TeardownHookResolutionSchema>;
