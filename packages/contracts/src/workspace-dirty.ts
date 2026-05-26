// Workspace-remove `dirtySummary`: bounded server-side (≤50 files, ≤20
// commits). Lives in its own file so the index.ts schema bundle stays
// under the 800-line file-size cap.

import { z } from "zod";

export const WorkspaceDirtySummarySchema = z.object({
  files: z.array(z.object({ status: z.string(), path: z.string() })),
  unpushedCommits: z.array(z.object({ sha: z.string(), subject: z.string() })),
});

export type WorkspaceDirtySummary = z.infer<typeof WorkspaceDirtySummarySchema>;
