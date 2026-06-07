import type {
  SystemHealthSnapshot,
  SystemHealthTone,
  SystemResourceOffender,
  SystemResourceOffenderBreakdown,
  SystemResourceType,
  WorkspaceSession,
} from "@citadel/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "./api.js";

type SystemHealthResponse = { systemHealth: SystemHealthSnapshot };
type SystemResourceOffendersResponse = { breakdown: SystemResourceOffenderBreakdown };
type ResourceMetricConfig = { type: SystemResourceType; label: string };
type BreakdownState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; breakdown: SystemResourceOffenderBreakdown }
  | { status: "error"; message: string };

const RESOURCE_METRICS = {
  cpu: { type: "cpu", label: "CPU" },
  memory: { type: "memory", label: "RAM" },
  disk: { type: "disk", label: "Disk" },
  disk_io: { type: "disk_io", label: "I/O" },
  citadel: { type: "citadel", label: "Citadel" },
} satisfies Record<SystemResourceType, ResourceMetricConfig>;

export function BottomBar(props: {
  activeSession: WorkspaceSession | null;
  sessions: WorkspaceSession[];
}) {
  const [now, setNow] = useState(() => formatClock(new Date()));
  const [activeResource, setActiveResource] = useState<ResourceMetricConfig | null>(null);
  const [breakdownState, setBreakdownState] = useState<BreakdownState>({ status: "idle" });
  useEffect(() => {
    const id = window.setInterval(() => setNow(formatClock(new Date())), 30_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!activeResource) {
      setBreakdownState({ status: "idle" });
      return;
    }
    const controller = new AbortController();
    setBreakdownState({ status: "loading" });
    api<SystemResourceOffendersResponse>(`/api/system-health/resources/${activeResource.type}/offenders`, {
      signal: controller.signal,
    })
      .then((response) => setBreakdownState({ status: "loaded", breakdown: response.breakdown }))
      .catch((error: unknown) => {
        if (isAbortError(error)) return;
        setBreakdownState({ status: "error", message: errorMessage(error) });
      });
    return () => controller.abort();
  }, [activeResource]);

  useEffect(() => {
    if (!activeResource) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setActiveResource(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeResource]);

  const systemHealth = useQuery<SystemHealthResponse>({
    queryKey: ["system-health"],
    queryFn: () => api<SystemHealthResponse>("/api/system-health"),
    refetchInterval: 30_000,
  });
  const health = systemHealth.data?.systemHealth ?? null;

  return (
    <footer className="cit-bottombar" aria-label="Status bar" onMouseLeave={() => setActiveResource(null)}>
      <div className="cit-bb-left">
        <span
          className={`cit-bb-health cit-bb-health--${health?.tone ?? "unknown"}`}
          title={health?.reason ?? healthTitle(health)}
        >
          <span className={`cit-pulse ${healthPulseClass(health?.tone ?? "unknown")}`} aria-hidden="true" />
          health {healthLabel(health?.tone ?? "unknown")}
        </span>
        <FooterMetric
          metric={RESOURCE_METRICS.cpu}
          active={activeResource?.type === "cpu"}
          onActivate={setActiveResource}
          value={formatPercent(health?.machine.cpu.percentUsed)}
          title={cpuTitle(health)}
        />
        <FooterMetric
          metric={RESOURCE_METRICS.memory}
          active={activeResource?.type === "memory"}
          onActivate={setActiveResource}
          value={formatPercent(health?.machine.memory.percentUsed)}
          title={memoryTitle(health)}
        />
        <FooterMetric
          metric={RESOURCE_METRICS.disk}
          active={activeResource?.type === "disk"}
          onActivate={setActiveResource}
          value={formatPercent(health?.machine.disk.percentUsed)}
          detail={`${formatBytes(health?.machine.disk.freeBytes)} free`}
          title={diskTitle(health)}
        />
        <FooterMetric
          metric={RESOURCE_METRICS.disk_io}
          active={activeResource?.type === "disk_io"}
          onActivate={setActiveResource}
          value={formatPercent(health?.machine.disk.ioUtilizationPercent)}
          title={diskIoTitle(health)}
        />
        <FooterMetric
          metric={RESOURCE_METRICS.citadel}
          active={activeResource?.type === "citadel"}
          onActivate={setActiveResource}
          value={formatBytes(health?.process.rssBytes)}
          detail="RSS"
          title={processTitle(health)}
          className="cit-bb-metric--process"
        />
      </div>
      <div className="cit-bb-right">
        <span className="cit-bb-time">{now}</span>
      </div>
      {activeResource ? (
        <ResourceBreakdownModal
          resource={activeResource}
          state={breakdownState}
          onClose={() => setActiveResource(null)}
        />
      ) : null}
    </footer>
  );
}

function FooterMetric(props: {
  metric: ResourceMetricConfig;
  value: string;
  detail?: string;
  title: string;
  className?: string;
  active: boolean;
  onActivate: (resource: ResourceMetricConfig) => void;
}) {
  return (
    <button
      type="button"
      className={`cit-bb-metric cit-bb-metric--hoverable ${props.active ? "cit-bb-metric--active" : ""} ${
        props.className ?? ""
      }`}
      title={props.title}
      aria-haspopup="dialog"
      aria-expanded={props.active}
      data-resource-type={props.metric.type}
      onFocus={() => props.onActivate(props.metric)}
      onMouseEnter={() => props.onActivate(props.metric)}
    >
      <span className="cit-bb-metric-label">{props.metric.label}</span>
      <span className="cit-bb-metric-value">{props.value}</span>
      {props.detail ? <span className="cit-bb-metric-detail">{props.detail}</span> : null}
    </button>
  );
}

function ResourceBreakdownModal(props: {
  resource: ResourceMetricConfig;
  state: BreakdownState;
  onClose: () => void;
}) {
  return (
    <dialog className="cit-resource-modal" aria-label={`${props.resource.label} resource offenders`} open>
      <div className="cit-resource-modal-head">
        <div>
          <span className="cit-resource-modal-kicker">{props.resource.label}</span>
          <h2>Top offenders</h2>
        </div>
        <button type="button" className="cit-resource-modal-close" aria-label="Close" onClick={props.onClose}>
          x
        </button>
      </div>
      <ResourceBreakdownBody state={props.state} />
    </dialog>
  );
}

function ResourceBreakdownBody(props: { state: BreakdownState }) {
  if (props.state.status === "loading") {
    return (
      <div className="cit-resource-modal-state" aria-live="polite">
        Loading breakdown...
      </div>
    );
  }
  if (props.state.status === "error") {
    return <div className="cit-resource-modal-state cit-resource-modal-state--bad">{props.state.message}</div>;
  }
  if (props.state.status !== "loaded") return null;
  const { breakdown } = props.state;
  if (breakdown.offenders.length === 0) {
    return (
      <div className="cit-resource-modal-state">
        {breakdown.reason ?? (breakdown.status === "unavailable" ? "Breakdown unavailable" : "No offenders reported")}
      </div>
    );
  }
  return (
    <ol className="cit-resource-offenders">
      {breakdown.offenders.map((offender) => (
        <li key={offender.id}>
          <div className="cit-resource-offender-main">
            <span className="cit-resource-offender-name">{offender.label}</span>
            <span className="cit-resource-offender-value">{formatOffenderValue(offender)}</span>
          </div>
          <div className="cit-resource-offender-detail">{offender.detail ?? offenderPid(offender)}</div>
        </li>
      ))}
    </ol>
  );
}

function healthPulseClass(tone: SystemHealthTone) {
  if (tone === "healthy") return "cit-pulse-ok";
  if (tone === "degraded") return "cit-pulse-run";
  if (tone === "critical") return "cit-pulse-bad";
  return "cit-pulse-idle";
}

function healthLabel(tone: SystemHealthTone) {
  if (tone === "healthy") return "ok";
  if (tone === "degraded") return "warn";
  if (tone === "critical") return "bad";
  return "unknown";
}

export function formatPercent(value: number | null | undefined) {
  if (value === null || value === undefined) return "n/a";
  return `${Math.round(value)}%`;
}

export function formatBytes(bytes: number | null | undefined) {
  if (bytes === null || bytes === undefined) return "n/a";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const precision = value >= 10 || unit === 0 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unit]}`;
}

function formatOffenderValue(offender: SystemResourceOffender) {
  if (offender.value === null || offender.value === undefined) return "n/a";
  if (offender.unit === "percent") return formatPercent(offender.value);
  if (offender.unit === "io_bytes") return `${formatBytes(offender.value)} I/O`;
  return formatBytes(offender.value);
}

function offenderPid(offender: SystemResourceOffender) {
  return offender.pid ? `pid ${offender.pid}` : "";
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function healthTitle(health: SystemHealthSnapshot | null) {
  if (!health) return "Health telemetry unavailable";
  return health.reason ?? `Checked ${formatCheckedAt(health.checkedAt)}`;
}

function cpuTitle(health: SystemHealthSnapshot | null) {
  if (!health) return "CPU telemetry unavailable";
  const cpu = health.machine.cpu;
  return `CPU ${formatPercent(cpu.percentUsed)} - load ${formatNullableNumber(cpu.loadAverage1m)} - ${cpu.cores} cores`;
}

function memoryTitle(health: SystemHealthSnapshot | null) {
  if (!health) return "Memory telemetry unavailable";
  const memory = health.machine.memory;
  return `RAM ${formatBytes(memory.usedBytes)} used of ${formatBytes(memory.totalBytes)} - ${formatBytes(memory.freeBytes)} free`;
}

function diskTitle(health: SystemHealthSnapshot | null) {
  if (!health) return "Disk telemetry unavailable";
  const disk = health.machine.disk;
  if (disk.error) return `Disk unavailable for ${disk.path}: ${disk.error}`;
  const device = disk.device ? ` - ${disk.device}` : "";
  return `Disk${device} ${formatBytes(disk.usedBytes)} used of ${formatBytes(disk.totalBytes)} - ${formatBytes(disk.freeBytes)} free`;
}

function diskIoTitle(health: SystemHealthSnapshot | null) {
  if (!health) return "Disk I/O telemetry unavailable";
  const disk = health.machine.disk;
  if (!disk.device) return "Disk I/O telemetry unavailable for this filesystem";
  return `Disk I/O utilization for ${disk.device}: ${formatPercent(disk.ioUtilizationPercent)}`;
}

function processTitle(health: SystemHealthSnapshot | null) {
  if (!health) return "Citadel process telemetry unavailable";
  const proc = health.process;
  return `Citadel process ${formatBytes(proc.rssBytes)} RSS - ${formatBytes(proc.heapUsedBytes)} heap`;
}

function formatNullableNumber(value: number | null | undefined) {
  if (value === null || value === undefined) return "n/a";
  return value.toFixed(2);
}

function formatCheckedAt(checkedAt: string) {
  return new Date(checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function formatClock(date: Date) {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}
