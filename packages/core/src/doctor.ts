import type {
  DoctorCheck,
  DoctorCheckKind,
  DoctorCheckStatus,
  DoctorSummary,
} from "@citadel/contracts/doctor";

// Pure helpers for the doctor surface. No fs/process/config/network access —
// those live in `@citadel/operations` per the architecture-boundary gate.

// Precedence:
//   any "fail"  → "failing"
//   any "warn"  → "degraded"
//   otherwise   → "ok"
// "skipped" never contributes — a probe that didn't apply must not raise the
// summary on its own.
export function summarizeDoctor(checks: readonly DoctorCheck[]): DoctorSummary {
  let sawWarn = false;
  for (const c of checks) {
    if (c.status === "fail") return "failing";
    if (c.status === "warn") sawWarn = true;
  }
  return sawWarn ? "degraded" : "ok";
}

// Group checks by kind for sectioned rendering in the cockpit diagnostics
// panel. Preserves input order inside each bucket.
export function groupChecksByKind(checks: readonly DoctorCheck[]): Partial<Record<DoctorCheckKind, DoctorCheck[]>> {
  const out: Partial<Record<DoctorCheckKind, DoctorCheck[]>> = {};
  for (const c of checks) {
    const bucket = out[c.kind] ?? (out[c.kind] = []);
    bucket.push(c);
  }
  return out;
}

const STATUS_LABELS: Record<DoctorCheckStatus, string> = {
  ok: "OK",
  warn: "Warning",
  fail: "Fail",
  skipped: "Skipped",
};

export function statusLabel(status: DoctorCheckStatus): string {
  return STATUS_LABELS[status];
}
