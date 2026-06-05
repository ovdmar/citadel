import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import type {
  SystemCpuSnapshot,
  SystemDiskSnapshot,
  SystemHealthSnapshot,
  SystemHealthTone,
  SystemMemorySnapshot,
} from "@citadel/contracts";

const GIB = 1024 ** 3;

type CpuSample = { idle: number; total: number };
type DiskIoSample = {
  device: string;
  ioMs: number;
  sampledAtMs: number;
};

let previousCpuSample: CpuSample | null = null;
let previousDiskIoSample: DiskIoSample | null = null;

export function collectSystemHealthSnapshot(input: { diskPath?: string; now?: Date } = {}): SystemHealthSnapshot {
  const cpuSample = readCpuSample();
  const cores = Math.max(os.cpus().length, 1);
  const loadAverage1m = os.loadavg()[0] ?? null;
  const cpu: SystemCpuSnapshot = {
    percentUsed: cpuSample ? cpuPercentUsed(cpuSample, previousCpuSample, loadAverage1m, cores) : null,
    loadAverage1m,
    cores,
  };
  previousCpuSample = cpuSample;

  const memory = collectMemorySnapshot();
  const disk = collectDiskSnapshot(input.diskPath ?? process.cwd());
  const processMemory = process.memoryUsage();
  const processPercent = memory.totalBytes > 0 ? clampPercent((processMemory.rss / memory.totalBytes) * 100) : null;
  const summary = deriveSystemHealthTone({
    cpuPercentUsed: cpu.percentUsed,
    memoryPercentUsed: memory.percentUsed,
    diskPercentUsed: disk.percentUsed,
    diskIoUtilizationPercent: disk.ioUtilizationPercent,
    diskFreeBytes: disk.freeBytes,
    diskError: disk.error,
    processMemoryPercentOfMachine: processPercent,
  });

  return {
    tone: summary.tone,
    reason: summary.reason,
    checkedAt: (input.now ?? new Date()).toISOString(),
    machine: { cpu, memory, disk },
    process: {
      pid: process.pid,
      rssBytes: processMemory.rss,
      heapUsedBytes: processMemory.heapUsed,
      heapTotalBytes: processMemory.heapTotal,
      percentOfMachineMemory: processPercent,
    },
  };
}

export function deriveSystemHealthTone(input: {
  cpuPercentUsed: number | null;
  memoryPercentUsed: number | null;
  diskPercentUsed: number | null;
  diskIoUtilizationPercent: number | null;
  diskFreeBytes: number | null;
  diskError: string | null;
  processMemoryPercentOfMachine: number | null;
}): { tone: SystemHealthTone; reason: string | null } {
  const findings: Array<{ tone: Exclude<SystemHealthTone, "healthy" | "unknown">; reason: string }> = [];
  addPercentFinding(findings, "CPU", input.cpuPercentUsed, 85, 95);
  addPercentFinding(findings, "RAM", input.memoryPercentUsed, 85, 95);
  addPercentFinding(findings, "disk", input.diskPercentUsed, 85, 95);
  addPercentFinding(findings, "disk I/O", input.diskIoUtilizationPercent, 80, 95);
  addPercentFinding(findings, "Citadel RAM", input.processMemoryPercentOfMachine, 50, 75);

  if (input.diskFreeBytes !== null) {
    if (input.diskFreeBytes < 2 * GIB) findings.push({ tone: "critical", reason: "disk space below 2 GB" });
    else if (input.diskFreeBytes < 10 * GIB) findings.push({ tone: "degraded", reason: "disk space below 10 GB" });
  }
  if (input.diskError) findings.push({ tone: "degraded", reason: `disk unavailable: ${input.diskError}` });

  const critical = findings.find((finding) => finding.tone === "critical");
  if (critical) return critical;
  const degraded = findings.find((finding) => finding.tone === "degraded");
  if (degraded) return degraded;
  if ([input.cpuPercentUsed, input.memoryPercentUsed, input.diskPercentUsed].every((value) => value === null)) {
    return { tone: "unknown", reason: "resource telemetry unavailable" };
  }
  return { tone: "healthy", reason: null };
}

function addPercentFinding(
  findings: Array<{ tone: "degraded" | "critical"; reason: string }>,
  label: string,
  value: number | null,
  warnAt: number,
  criticalAt: number,
) {
  if (value === null) return;
  const rounded = Math.round(value);
  if (value >= criticalAt) findings.push({ tone: "critical", reason: `${label} ${rounded}%` });
  else if (value >= warnAt) findings.push({ tone: "degraded", reason: `${label} ${rounded}%` });
}

function collectMemorySnapshot(): SystemMemorySnapshot {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const usedBytes = Math.max(0, totalBytes - freeBytes);
  return {
    totalBytes,
    usedBytes,
    freeBytes,
    percentUsed: totalBytes > 0 ? clampPercent((usedBytes / totalBytes) * 100) : null,
  };
}

function collectDiskSnapshot(diskPath: string): SystemDiskSnapshot {
  const io = collectDiskIoSnapshot(diskPath);
  try {
    const stats = fs.statfsSync(diskPath);
    const blockSize = Number(stats.bsize);
    const totalBytes = Number(stats.blocks) * blockSize;
    const freeBytes = Number(stats.bavail) * blockSize;
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    return {
      path: diskPath,
      device: io.device,
      totalBytes,
      usedBytes,
      freeBytes,
      percentUsed: totalBytes > 0 ? clampPercent((usedBytes / totalBytes) * 100) : null,
      ioUtilizationPercent: io.percentUsed,
      error: null,
    };
  } catch (error) {
    return {
      path: diskPath,
      device: io.device,
      totalBytes: null,
      usedBytes: null,
      freeBytes: null,
      percentUsed: null,
      ioUtilizationPercent: io.percentUsed,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function collectDiskIoSnapshot(diskPath: string): { device: string | null; percentUsed: number | null } {
  const sample = readDiskIoSample(diskPath);
  if (!sample) {
    previousDiskIoSample = null;
    return { device: null, percentUsed: null };
  }
  const previous = previousDiskIoSample;
  previousDiskIoSample = sample;
  if (!previous || previous.device !== sample.device || sample.sampledAtMs <= previous.sampledAtMs) {
    return { device: sample.device, percentUsed: null };
  }
  const elapsedMs = sample.sampledAtMs - previous.sampledAtMs;
  const ioDeltaMs = sample.ioMs - previous.ioMs;
  if (elapsedMs <= 0 || ioDeltaMs < 0) return { device: sample.device, percentUsed: null };
  return { device: sample.device, percentUsed: clampPercent((ioDeltaMs / elapsedMs) * 100) };
}

function readDiskIoSample(diskPath: string): DiskIoSample | null {
  const device = diskDeviceForPath(diskPath);
  if (!device) return null;
  let raw = "";
  try {
    raw = fs.readFileSync("/proc/diskstats", "utf8");
  } catch {
    return null;
  }
  for (const line of raw.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields[2] !== device) continue;
    const ioMs = Number(fields[12]);
    if (!Number.isFinite(ioMs)) return null;
    return { device, ioMs, sampledAtMs: Date.now() };
  }
  return null;
}

function diskDeviceForPath(diskPath: string): string | null {
  const source = mountSourceForPath(diskPath);
  if (!source) return null;
  if (source.startsWith("/dev/")) {
    try {
      return path.basename(fs.realpathSync(source));
    } catch {
      return path.basename(source);
    }
  }
  return null;
}

function mountSourceForPath(diskPath: string): string | null {
  let raw = "";
  try {
    raw = fs.readFileSync("/proc/self/mountinfo", "utf8");
  } catch {
    return null;
  }
  const absolutePath = path.resolve(diskPath);
  let best: { mountPoint: string; source: string } | null = null;
  for (const line of raw.split("\n")) {
    const parts = line.split(" ");
    const separator = parts.indexOf("-");
    if (separator < 0 || separator + 2 >= parts.length) continue;
    const mountPoint = decodeProcPath(parts[4] ?? "");
    const source = parts[separator + 2] ?? "";
    if (!mountPoint || !source) continue;
    const matches = absolutePath === mountPoint || absolutePath.startsWith(`${mountPoint.replace(/\/$/, "")}/`);
    if (!matches) continue;
    if (!best || mountPoint.length > best.mountPoint.length) best = { mountPoint, source };
  }
  return best?.source ?? null;
}

function decodeProcPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

function readCpuSample(): CpuSample | null {
  const cpus = os.cpus();
  if (cpus.length === 0) return null;
  return cpus.reduce<CpuSample>(
    (acc, cpu) => {
      const total = cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
      return { idle: acc.idle + cpu.times.idle, total: acc.total + total };
    },
    { idle: 0, total: 0 },
  );
}

export function cpuPercentUsed(
  current: CpuSample,
  previous: CpuSample | null,
  loadAverage1m: number | null,
  cores: number,
): number | null {
  if (previous && current.total > previous.total) {
    const totalDelta = current.total - previous.total;
    const idleDelta = current.idle - previous.idle;
    return clampPercent((1 - idleDelta / totalDelta) * 100);
  }
  if (loadAverage1m === null || cores <= 0) return null;
  return clampPercent((loadAverage1m / cores) * 100);
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value * 10) / 10));
}
