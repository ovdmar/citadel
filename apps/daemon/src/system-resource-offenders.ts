import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import type { SystemResourceOffender, SystemResourceOffenderBreakdown, SystemResourceType } from "@citadel/contracts";

const execFileAsync = promisify(execFile);
const MAX_OFFENDERS = 5;

type ProcessSnapshot = {
  pid: number;
  command: string;
  args: string;
  cpuPercent: number;
  memoryPercent: number;
  rssBytes: number;
};

export async function collectSystemResourceOffenders(input: {
  resource: SystemResourceType;
  dataDir: string;
  now?: Date;
}): Promise<SystemResourceOffenderBreakdown> {
  const checkedAt = (input.now ?? new Date()).toISOString();
  try {
    const offenders = await collectOffenders(input.resource, input.dataDir);
    return {
      resource: input.resource,
      checkedAt,
      offenders,
      status: "available",
      reason: offenders.length === 0 ? "No readable offenders for this resource" : null,
    };
  } catch (error) {
    return {
      resource: input.resource,
      checkedAt,
      offenders: [],
      status: "unavailable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function collectOffenders(resource: SystemResourceType, dataDir: string): Promise<SystemResourceOffender[]> {
  if (resource === "disk") return collectDiskOffenders(dataDir);
  if (resource === "disk_io") return collectDiskIoOffenders();

  const processes = await readProcessSnapshots();
  if (resource === "cpu") return topProcessOffenders(processes, "cpuPercent", "percent");
  if (resource === "memory") return topProcessOffenders(processes, "rssBytes", "bytes");
  return topCitadelProcesses(processes);
}

async function readProcessSnapshots(): Promise<ProcessSnapshot[]> {
  const { stdout } = await execFileAsync("ps", ["-eo", "pid=,pcpu=,pmem=,rss=,comm=,args="], {
    timeout: 1500,
    maxBuffer: 768 * 1024,
  });
  return parsePsProcessTable(stdout);
}

export function parsePsProcessTable(stdout: string): ProcessSnapshot[] {
  const snapshots: ProcessSnapshot[] = [];
  for (const line of stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s*(.*)$/);
    if (!match) continue;
    const pid = Number.parseInt(match[1] ?? "", 10);
    const cpuPercent = Number.parseFloat(match[2] ?? "");
    const memoryPercent = Number.parseFloat(match[3] ?? "");
    const rssKiB = Number.parseInt(match[4] ?? "", 10);
    const command = match[5] ?? "";
    if (![pid, cpuPercent, memoryPercent, rssKiB].every(Number.isFinite) || !command) continue;
    snapshots.push({
      pid,
      command,
      args: (match[6] ?? "").trim(),
      cpuPercent,
      memoryPercent,
      rssBytes: rssKiB * 1024,
    });
  }
  return snapshots;
}

function topProcessOffenders(
  processes: ProcessSnapshot[],
  metric: "cpuPercent" | "rssBytes",
  unit: "percent" | "bytes",
): SystemResourceOffender[] {
  return processes
    .filter((candidate) => candidate[metric] > 0)
    .sort((a, b) => b[metric] - a[metric])
    .slice(0, MAX_OFFENDERS)
    .map((candidate) => processOffender(candidate, candidate[metric], unit));
}

function topCitadelProcesses(processes: ProcessSnapshot[]): SystemResourceOffender[] {
  const citadelProcesses = processes.filter((candidate) =>
    `${candidate.command} ${candidate.args}`.toLowerCase().includes("citadel"),
  );
  const offenders = topProcessOffenders(citadelProcesses, "rssBytes", "bytes");
  if (offenders.length > 0) return offenders;
  const rssBytes = process.memoryUsage().rss;
  return [
    {
      id: `pid:${process.pid}`,
      label: "citadel daemon",
      detail: process.argv.join(" "),
      pid: process.pid,
      value: rssBytes,
      unit: "bytes",
    },
  ];
}

function processOffender(
  processSnapshot: ProcessSnapshot,
  value: number,
  unit: "percent" | "bytes",
): SystemResourceOffender {
  return {
    id: `pid:${processSnapshot.pid}`,
    label: processSnapshot.command,
    detail: processSnapshot.args || `pid ${processSnapshot.pid}`,
    pid: processSnapshot.pid,
    value,
    unit,
  };
}

async function collectDiskOffenders(dataDir: string): Promise<SystemResourceOffender[]> {
  const entries = fs
    .readdirSync(dataDir, { withFileTypes: true })
    .filter((entry) => entry.name !== "." && entry.name !== "..")
    .slice(0, 250)
    .map((entry) => path.join(dataDir, entry.name));
  if (entries.length === 0) return [];

  const { stdout } = await execFileAsync("du", ["-sk", "--", ...entries], {
    timeout: 2500,
    maxBuffer: 512 * 1024,
  });
  return parseDuOutput(stdout);
}

export function parseDuOutput(stdout: string): SystemResourceOffender[] {
  return stdout
    .split("\n")
    .flatMap((line) => {
      const match = line.match(/^\s*(\d+)\s+(.+)$/);
      if (!match) return [];
      const sizeKiB = Number.parseInt(match[1] ?? "", 10);
      const filePath = match[2] ?? "";
      if (!Number.isFinite(sizeKiB) || !filePath) return [];
      return [
        {
          id: `path:${filePath}`,
          label: path.basename(filePath) || filePath,
          detail: filePath,
          pid: null,
          value: sizeKiB * 1024,
          unit: "bytes" as const,
        },
      ];
    })
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
    .slice(0, MAX_OFFENDERS);
}

function collectDiskIoOffenders(): SystemResourceOffender[] {
  let procEntries: string[];
  try {
    procEntries = fs.readdirSync("/proc");
  } catch (error) {
    throw new Error(`process I/O telemetry unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  return procEntries
    .flatMap((entry) => diskIoOffenderForPid(entry))
    .filter((offender) => (offender.value ?? 0) > 0)
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
    .slice(0, MAX_OFFENDERS);
}

function diskIoOffenderForPid(entry: string): SystemResourceOffender[] {
  if (!/^\d+$/.test(entry)) return [];
  const pid = Number.parseInt(entry, 10);
  try {
    const io = parseProcIo(fs.readFileSync(path.join("/proc", entry, "io"), "utf8"));
    const value = io.readBytes + io.writeBytes;
    const label = readProcCommand(entry);
    return [
      {
        id: `pid:${pid}:io`,
        label,
        detail: `pid ${pid}`,
        pid,
        value,
        unit: "io_bytes",
      },
    ];
  } catch {
    return [];
  }
}

function parseProcIo(raw: string): { readBytes: number; writeBytes: number } {
  let readBytes = 0;
  let writeBytes = 0;
  for (const line of raw.split("\n")) {
    const [key, value] = line.split(":");
    const parsed = Number.parseInt((value ?? "").trim(), 10);
    if (!Number.isFinite(parsed)) continue;
    if (key === "read_bytes") readBytes = parsed;
    if (key === "write_bytes") writeBytes = parsed;
  }
  return { readBytes, writeBytes };
}

function readProcCommand(entry: string): string {
  try {
    const cmdline = fs
      .readFileSync(path.join("/proc", entry, "cmdline"), "utf8")
      .replace(/\0/g, " ")
      .trim();
    if (cmdline) return cmdline.split(/\s+/)[0] ?? "process";
  } catch {
    // Fall through to comm.
  }
  try {
    return fs.readFileSync(path.join("/proc", entry, "comm"), "utf8").trim() || "process";
  } catch {
    return "process";
  }
}
