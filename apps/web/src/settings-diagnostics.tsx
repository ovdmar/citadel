import type { DoctorCheck, DoctorCheckKind, DoctorReport } from "@citadel/contracts/doctor";
import { useQuery } from "@tanstack/react-query";
import { RefreshCcw } from "lucide-react";
import { api } from "./api.js";
import { Button } from "./components/ui/button.js";

// Reachable from /settings → Diagnostics. Renders the daemon's DoctorReport
// (`GET /api/doctor`) with kind-grouped sections and an explicit "report
// version unknown" banner when the daemon's report disagrees with the
// cockpit's expected version (forward-compat).

const KIND_ORDER: DoctorCheckKind[] = ["binary", "service", "daemon", "config", "database", "repo-hooks", "provider"];

const KIND_LABEL: Record<DoctorCheckKind, string> = {
  binary: "Binaries",
  service: "Systemd services",
  daemon: "Daemon",
  config: "Config",
  database: "Database",
  "repo-hooks": "Repositories",
  provider: "Providers",
};

const SUMMARY_LABEL: Record<DoctorReport["summary"], { text: string; tone: "ok" | "warn" | "fail" }> = {
  ok: { text: "OK", tone: "ok" },
  degraded: { text: "Degraded", tone: "warn" },
  failing: { text: "Failing", tone: "fail" },
};

const STATUS_GLYPH: Record<DoctorCheck["status"], string> = {
  ok: "✓",
  warn: "!",
  fail: "✗",
  skipped: "·",
};

export function DiagnosticsPanel() {
  const report = useQuery({
    queryKey: ["doctor"],
    queryFn: () => api<DoctorReport>("/api/doctor"),
    refetchInterval: 30_000,
  });

  if (report.isLoading) {
    return <div className="diag-loading">Running diagnostics…</div>;
  }
  if (report.error || !report.data) {
    return (
      <div className="diag-error">
        <div>Diagnostics unavailable: {String(report.error)}</div>
        <Button type="button" onClick={() => report.refetch()}>
          <RefreshCcw size={14} /> Retry
        </Button>
      </div>
    );
  }
  const data = report.data;

  // Forward-compat: if the daemon advertises a version we don't know how to
  // render, show a banner and dump the raw JSON. Lets future daemon work ship
  // a v2 report without breaking older cockpits.
  if (data.version !== 1) {
    return (
      <section className="panel diag">
        <div className="diag-version-banner">
          Diagnostics report version {data.version} is unknown to this cockpit. Upgrade the cockpit (or downgrade the
          daemon) to see a structured rendering. Raw JSON shown below.
        </div>
        <pre className="diag-raw-json">{JSON.stringify(data, null, 2)}</pre>
      </section>
    );
  }

  const summary = SUMMARY_LABEL[data.summary];
  const grouped: Partial<Record<DoctorCheckKind, DoctorCheck[]>> = {};
  for (const c of data.checks) {
    let bucket = grouped[c.kind];
    if (!bucket) {
      bucket = [];
      grouped[c.kind] = bucket;
    }
    bucket.push(c);
  }

  return (
    <section className="panel diag">
      <header className="diag-summary">
        <div className={`diag-badge diag-badge-${summary.tone}`}>{summary.text}</div>
        <div className="diag-meta">
          <div>{data.bindUrl}</div>
          <div className="diag-meta-time">Checked {new Date(data.generatedAt).toLocaleTimeString()}</div>
        </div>
        <Button type="button" variant="ghost" size="icon" onClick={() => report.refetch()}>
          <RefreshCcw size={14} />
        </Button>
      </header>

      {KIND_ORDER.map((kind) => {
        const checks = grouped[kind];
        if (!checks || checks.length === 0) return null;
        return (
          <div key={kind} className="diag-group">
            <h3 className="diag-group-title">{KIND_LABEL[kind]}</h3>
            <ul className="diag-list">
              {checks.map((check) => (
                <li key={check.id} className={`diag-row diag-row-${check.status}`}>
                  <span className="diag-glyph" aria-hidden>
                    {STATUS_GLYPH[check.status]}
                  </span>
                  <div className="diag-row-body">
                    <div className="diag-row-label">{check.label}</div>
                    {check.detail ? <div className="diag-row-detail">{check.detail}</div> : null}
                    {check.hint && (check.status === "warn" || check.status === "fail") ? (
                      <div className="diag-row-hint">hint: {check.hint}</div>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
