import type { SystemHealthSnapshot, SystemHealthTone, WorkspaceSession } from "@citadel/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "./api.js";

type SystemHealthResponse = { systemHealth: SystemHealthSnapshot };

export function BottomBar(props: {
  activeSession: WorkspaceSession | null;
  sessions: WorkspaceSession[];
}) {
  const [now, setNow] = useState(() => formatClock(new Date()));
  useEffect(() => {
    const id = window.setInterval(() => setNow(formatClock(new Date())), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const systemHealth = useQuery<SystemHealthResponse>({
    queryKey: ["system-health"],
    queryFn: () => api<SystemHealthResponse>("/api/system-health"),
    refetchInterval: 30_000,
  });
  const health = systemHealth.data?.systemHealth ?? null;

  return (
    <footer className="cit-bottombar" aria-label="Status bar">
      <div className="cit-bb-left">
        <span
          className={`cit-bb-health cit-bb-health--${health?.tone ?? "unknown"}`}
          title={health?.reason ?? healthTitle(health)}
        >
          <span className={`cit-pulse ${healthPulseClass(health?.tone ?? "unknown")}`} aria-hidden="true" />
          health {healthLabel(health?.tone ?? "unknown")}
        </span>
        <FooterMetric label="CPU" value={formatPercent(health?.machine.cpu.percentUsed)} title={cpuTitle(health)} />
        <FooterMetric
          label="RAM"
          value={formatPercent(health?.machine.memory.percentUsed)}
          title={memoryTitle(health)}
        />
        <FooterMetric
          label="Disk"
          value={formatPercent(health?.machine.disk.percentUsed)}
          detail={`${formatBytes(health?.machine.disk.freeBytes)} free`}
          title={diskTitle(health)}
        />
        <FooterMetric
          label="I/O"
          value={formatPercent(health?.machine.disk.ioUtilizationPercent)}
          title={diskIoTitle(health)}
        />
        <FooterMetric
          label="Citadel"
          value={formatBytes(health?.process.rssBytes)}
          detail="RSS"
          title={processTitle(health)}
          className="cit-bb-metric--process"
        />
      </div>
      <div className="cit-bb-right">
        <span className="cit-bb-time">{now}</span>
      </div>
    </footer>
  );
}

function FooterMetric(props: { label: string; value: string; detail?: string; title: string; className?: string }) {
  return (
    <span className={`cit-bb-metric ${props.className ?? ""}`} title={props.title}>
      <span className="cit-bb-metric-label">{props.label}</span>
      <span className="cit-bb-metric-value">{props.value}</span>
      {props.detail ? <span className="cit-bb-metric-detail">{props.detail}</span> : null}
    </span>
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
