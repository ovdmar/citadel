import type { CitadelConfig } from "@citadel/config";

export const E2E_RUN_ID_HEADER = "x-citadel-e2e-run-id";

export function e2eRunIdMismatch(presented: string | undefined) {
  if (!presented) return null;
  const expected = process.env.CITADEL_E2E_RUN_ID;
  if (expected && presented === expected) return null;
  return {
    error: "e2e_run_id_mismatch",
    message: expected
      ? "This daemon was launched for a different Playwright e2e run."
      : "This daemon was not launched as a Playwright e2e daemon.",
  };
}

export function e2eHealthFields(config: Pick<CitadelConfig, "dataDir">) {
  const runId = process.env.CITADEL_E2E_RUN_ID;
  return runId ? { e2e: { enabled: true, runId, dataDir: config.dataDir } } : {};
}
