// `make doctor` entry point. Runs the same DoctorReport pipeline as
// GET /api/doctor — but in CLI mode, which adds checks the daemon cannot do
// itself (host-binary presence, systemd unit status). The daemon's
// /api/doctor is fetched and its checks are merged in (with 5×1s retry on
// the reachability probe so an async systemctl restart doesn't flag fail).
//
// Usage:
//   pnpm exec tsx scripts/doctor/run.ts
//   pnpm exec tsx scripts/doctor/run.ts --json

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { loadConfig } from "@citadel/config";
import type { DoctorReport } from "@citadel/contracts/doctor";
import { groupChecksByKind, statusLabel, summarizeDoctor } from "@citadel/core";
import {
  type DeployHookStatus,
  type DoctorDeps,
  runDoctorChecks,
} from "@citadel/operations";
import { DEPLOY_HOOK_RELATIVE_PATH } from "@citadel/hooks";
import fs from "node:fs";
import path from "node:path";

const execFile = promisify(execFileCb);

function inspectDeployHookFile(workspacePath: string): DeployHookStatus {
  const filePath = path.join(workspacePath, DEPLOY_HOOK_RELATIVE_PATH);
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return "missing";
    try {
      fs.accessSync(filePath, fs.constants.X_OK);
      return "executable";
    } catch {
      return "exists-not-executable";
    }
  } catch {
    return "missing";
  }
}

async function cliDeps(): Promise<DoctorDeps> {
  return {
    which: async (bin: string) => {
      try {
        const { stdout } = await execFile("bash", ["-c", `command -v ${bin}`], { timeout: 2000 });
        const out = stdout.trim();
        return out.length > 0 ? out : null;
      } catch {
        return null;
      }
    },
    fetchHealth: async (url: string) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    readDbSchemaVersion: async () => null, // CLI: daemon mode reports this; we skip.
    expectedSchemaVersion: 0,
    listRepos: () => [], // CLI: per-repo checks come from the daemon's report below.
    inspectDeployHook: inspectDeployHookFile,
    listSystemdServices: async () => {
      try {
        const { stdout: avail } = await execFile("systemctl", ["--user", "list-units"], { timeout: 2000 });
        const available = avail.length >= 0; // any output (or empty) means systemctl is callable
        const isActive = async (unit: string) => {
          try {
            const { stdout } = await execFile("systemctl", ["--user", "is-active", unit], { timeout: 2000 });
            return stdout.trim() === "active";
          } catch {
            return false;
          }
        };
        return {
          available,
          citadel: (await isActive("citadel.service")) ? "ok" : "fail",
          tmux: (await isActive("citadel-tmux.service")) ? "ok" : "fail",
        };
      } catch {
        return { available: false, citadel: "skipped", tmux: "skipped" };
      }
    },
    collectProviderHealth: async () => [], // CLI: provider health comes from the daemon's report below.
    fsStat: (filePath: string) => {
      try {
        const stat = fs.statSync(filePath);
        return { exists: true, size: stat.size };
      } catch {
        return { exists: false, size: 0 };
      }
    },
    retries: 5,
    retryDelayMs: 1000,
  };
}

async function fetchDaemonReport(bindUrl: string): Promise<DoctorReport | null> {
  try {
    const res = await fetch(`${bindUrl}/api/doctor`);
    if (!res.ok) return null;
    return (await res.json()) as DoctorReport;
  } catch {
    return null;
  }
}

function statusGlyph(status: string): string {
  if (status === "ok") return "✓";
  if (status === "warn") return "!";
  if (status === "fail") return "✗";
  return "·";
}

function renderHuman(report: DoctorReport): string {
  const lines: string[] = [];
  const summaryBadge =
    report.summary === "ok" ? "OK" : report.summary === "degraded" ? "DEGRADED" : "FAILING";
  lines.push(`Citadel doctor — ${summaryBadge}`);
  lines.push(`URL:  ${report.bindUrl}  (protocol: ${report.protocol})`);
  lines.push(`Time: ${report.generatedAt}`);
  lines.push("");
  const grouped = groupChecksByKind(report.checks);
  const KIND_ORDER = ["binary", "service", "daemon", "config", "database", "repo-hooks", "provider"] as const;
  for (const kind of KIND_ORDER) {
    const checks = grouped[kind];
    if (!checks || checks.length === 0) continue;
    lines.push(`  ${kind}`);
    for (const c of checks) {
      lines.push(`    ${statusGlyph(c.status)} [${statusLabel(c.status).padEnd(8)}] ${c.label}`);
      if (c.detail) lines.push(`        ${c.detail}`);
      if (c.hint && (c.status === "warn" || c.status === "fail")) {
        lines.push(`        hint: ${c.hint}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");

  const config = (() => {
    try {
      return loadConfig();
    } catch (err) {
      // Surface as a config check rather than crashing the script.
      console.error("doctor: could not load config", err);
      return null;
    }
  })();

  if (!config) {
    const fallback: DoctorReport = {
      version: 1,
      generatedAt: new Date().toISOString(),
      summary: "failing",
      protocol: "http",
      bindUrl: "http://unknown",
      checks: [
        {
          id: "config.load",
          kind: "config",
          label: "load citadel.config.json",
          status: "fail",
          detail: "config file missing or invalid; run `make install`",
        },
      ],
    };
    if (asJson) console.log(JSON.stringify(fallback, null, 2));
    else console.log(renderHuman(fallback));
    process.exit(1);
  }

  const deps = await cliDeps();
  const cliReport = await runDoctorChecks({
    config: {
      bindHost: config.bindHost,
      port: config.port,
      providers: config.providers,
      tls: config.tls,
    },
    mode: "cli",
    deps,
  });

  // Merge in the daemon's report (per-repo hooks, schema, providers) when reachable.
  const daemonReport = await fetchDaemonReport(cliReport.bindUrl);
  const merged: DoctorReport = (() => {
    if (!daemonReport) return cliReport;
    const seen = new Set(cliReport.checks.map((c) => c.id));
    const extra = daemonReport.checks.filter((c) => !seen.has(c.id));
    const checks = [...cliReport.checks, ...extra];
    return {
      ...cliReport,
      checks,
      summary: summarizeDoctor(checks),
    };
  })();

  if (asJson) {
    console.log(JSON.stringify(merged, null, 2));
  } else {
    console.log(renderHuman(merged));
  }
  process.exit(merged.summary === "failing" ? 1 : 0);
}

main().catch((err) => {
  console.error("doctor: unexpected error", err);
  process.exit(2);
});
