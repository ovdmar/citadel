import { z } from "zod";

// Status of a single doctor check.
// - "ok"      — the check confirms a working state.
// - "warn"    — degraded but functional (e.g., recommended binary missing,
//               provider unconfigured, cert near expiry). Top-line goes to
//               "degraded" if any check is "warn".
// - "fail"    — broken state (e.g., required binary missing, daemon
//               unreachable after retries, cert expired). Top-line goes to
//               "failing".
// - "skipped" — the check did not apply in this context (e.g., systemd
//               check from a worktree-dev daemon). Does not contribute to
//               the summary.
export const DoctorCheckStatusSchema = z.enum(["ok", "warn", "fail", "skipped"]);
export type DoctorCheckStatus = z.infer<typeof DoctorCheckStatusSchema>;

// Kind of a check — discriminator for grouping in the UI and for routing
// repo-specific checks. New kinds may be added; clients render unknown kinds
// generically.
export const DoctorCheckKindSchema = z.enum([
  "binary",
  "config",
  "service",
  "daemon",
  "database",
  "repo-hooks",
  "provider",
]);
export type DoctorCheckKind = z.infer<typeof DoctorCheckKindSchema>;

export const DoctorCheckSchema = z.object({
  id: z.string().min(1),
  kind: DoctorCheckKindSchema,
  label: z.string().min(1),
  status: DoctorCheckStatusSchema,
  detail: z.string().optional(),
  hint: z.string().optional(),
});
export type DoctorCheck = z.infer<typeof DoctorCheckSchema>;

export const DoctorSummarySchema = z.enum(["ok", "degraded", "failing"]);
export type DoctorSummary = z.infer<typeof DoctorSummarySchema>;

export const DoctorProtocolSchema = z.enum(["http", "https"]);
export type DoctorProtocol = z.infer<typeof DoctorProtocolSchema>;

// Wire contract for both `make doctor` and `GET /api/doctor`.
//
// `version` is a literal so forward-compat clients (older cockpit talking to
// a newer daemon) can render an explicit "report version unknown — upgrade
// cockpit" banner instead of silently mis-parsing.
export const DoctorReportSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string().datetime(),
  summary: DoctorSummarySchema,
  protocol: DoctorProtocolSchema,
  bindUrl: z.string().min(1),
  checks: z.array(DoctorCheckSchema),
});
export type DoctorReport = z.infer<typeof DoctorReportSchema>;
