import type { DoctorCheck, DoctorCheckStatus, DoctorReport } from "@citadel/contracts/doctor";
import { summarizeDoctor } from "@citadel/core";

// Status used by the doctor for an individual provider probe. Mirrors the
// vocabulary of @citadel/contracts ProviderStatus but kept local so the
// doctor doesn't depend on the broader provider contract.
export type DoctorProviderStatus = "healthy" | "degraded" | "unavailable" | "unknown";
export type DoctorProviderProbe = { provider: string; status: DoctorProviderStatus };

// Minimal shape of a repo for hook diagnostics. We import the full type from
// @citadel/contracts via the consumer; this local shape keeps the deps
// surface narrow and testable.
export type DoctorRepo = {
  id: string;
  name: string;
  rootPath: string;
  setupHookIds: string[];
  teardownHookIds: string[];
  deployHookCommand: string | null;
};

// Minimal config shape used by the doctor. We accept any object that has
// these properties — the caller passes the real CitadelConfig.
export type DoctorConfig = {
  bindHost: string;
  port: number;
  providers: { github: { enabled: boolean; command: string }; jira: { enabled: boolean; command: string } };
  agentRuntimes: Array<{ id: string; displayName: string; command: string }>;
  terminal: { displayName: string; command: string };
  tls?: { certPath: string; keyPath: string } | undefined;
};

// Deployment-hook resolution states the doctor cares about. Mirrors
// packages/hooks/src/deploy.ts's HookFileStatus but kept local for the same
// reason as DoctorProviderStatus.
export type DeployHookStatus = "executable" | "exists-not-executable" | "missing";

export type DoctorDeps = {
  /** Resolve a binary in PATH. Returns null when the binary is unavailable. */
  which: (bin: string) => Promise<string | null>;
  /** HTTP probe for daemon-reachability. Throws on failure; returns body on success. */
  fetchHealth: (url: string) => Promise<unknown>;
  /** Latest applied schema version from the running DB, or null when unavailable. */
  readDbSchemaVersion: (databasePath: string) => Promise<number | null>;
  /** Compile-time constant exported from @citadel/db; the expected schema version. */
  expectedSchemaVersion: number;
  /** Snapshot of registered repos for per-repo hook checks. */
  listRepos: () => DoctorRepo[];
  /** Resolve <workspacePath>/.citadel/hooks/deploy executability. */
  inspectDeployHook: (workspacePath: string) => DeployHookStatus;
  /**
   * systemd --user query. `available: false` short-circuits both
   * service checks to `skipped` (dev-worktree, non-systemd hosts).
   */
  listSystemdServices: () => Promise<{
    available: boolean;
    citadel: DoctorCheckStatus;
    tmux: DoctorCheckStatus;
  }>;
  /** Provider-health snapshot used to distinguish unreachable from unconfigured. */
  collectProviderHealth: () => Promise<DoctorProviderProbe[]>;
  /** Bounded fs probe used by config-file existence + cert-size checks. */
  fsStat: (filePath: string) => { exists: boolean; size: number };
  /** Number of attempts for the daemon-reachability check. Default 5. */
  retries: number;
  /** Delay between retries in ms. Tests pass 0 to avoid waits. */
  retryDelayMs: number;
};

const REQUIRED_BINARIES = ["node", "pnpm", "tmux", "bash", "git", "sqlite3", "jq"] as const;
const RECOMMENDED_BINARIES = ["gh", "jtk"] as const;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function checkBinaries(deps: DoctorDeps, mode: "cli" | "daemon"): Promise<DoctorCheck[]> {
  if (mode === "daemon") {
    // The daemon's host has these by definition — running this check from
    // the daemon would just confirm it can call which() on itself.
    return REQUIRED_BINARIES.concat(RECOMMENDED_BINARIES as unknown as typeof REQUIRED_BINARIES).map((bin) => ({
      id: `binary.${bin}`,
      kind: "binary" as const,
      label: bin,
      status: "skipped" as const,
      detail: "skipped in daemon mode",
    }));
  }
  const checks: DoctorCheck[] = [];
  for (const bin of REQUIRED_BINARIES) {
    const found = await deps.which(bin);
    checks.push({
      id: `binary.${bin}`,
      kind: "binary",
      label: bin,
      status: found ? "ok" : "fail",
      detail: found ? found : "not found in PATH",
      hint: found ? undefined : `install ${bin} and ensure it is on PATH`,
    });
  }
  for (const bin of RECOMMENDED_BINARIES) {
    const found = await deps.which(bin);
    checks.push({
      id: `binary.${bin}`,
      kind: "binary",
      label: bin,
      status: found ? "ok" : "warn",
      detail: found ? found : "not found in PATH",
      hint: found ? undefined : `${bin} is recommended — enables a Citadel provider`,
    });
  }
  return checks;
}

async function checkDaemonReachability(config: DoctorConfig, deps: DoctorDeps): Promise<DoctorCheck> {
  const url = `${config.tls ? "https" : "http"}://${config.bindHost}:${config.port}/api/health`;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < deps.retries; attempt++) {
    try {
      await deps.fetchHealth(url);
      return {
        id: "daemon.health",
        kind: "daemon",
        label: "daemon /api/health",
        status: "ok",
        detail: `reached ${url} (attempt ${attempt + 1}/${deps.retries})`,
      };
    } catch (err) {
      lastError = err;
      if (attempt < deps.retries - 1) await sleep(deps.retryDelayMs);
    }
  }
  return {
    id: "daemon.health",
    kind: "daemon",
    label: "daemon /api/health",
    status: "fail",
    detail: `unreachable after ${deps.retries} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    hint: "confirm citadel.service is running: `systemctl --user status citadel.service` (or `make deploy` for worktree dev)",
  };
}

async function checkSchemaVersion(databasePath: string, deps: DoctorDeps): Promise<DoctorCheck> {
  const actual = await deps.readDbSchemaVersion(databasePath);
  if (actual == null) {
    return {
      id: "database.schema",
      kind: "database",
      label: "database schema version",
      status: "skipped",
      detail: `could not read schema_migrations from ${databasePath}`,
    };
  }
  const ok = actual >= deps.expectedSchemaVersion;
  return {
    id: "database.schema",
    kind: "database",
    label: "database schema version",
    status: ok ? "ok" : "fail",
    detail: `applied: ${actual}, expected: ${deps.expectedSchemaVersion}`,
    hint: ok ? undefined : "run the daemon at least once to apply pending migrations",
  };
}

function checkRepoHooks(repo: DoctorRepo, deps: DoctorDeps): DoctorCheck {
  const deployStatus = deps.inspectDeployHook(repo.rootPath);
  const hasBoundHooks = repo.setupHookIds.length + repo.teardownHookIds.length > 0;
  const hasDeploy = deployStatus === "executable";
  const hasDeployFallback = (repo.deployHookCommand ?? "").trim().length > 0;
  if (hasBoundHooks || hasDeploy || hasDeployFallback) {
    return {
      id: `repo-hooks.${repo.id}`,
      kind: "repo-hooks",
      label: `${repo.name} hooks`,
      status: "ok",
      detail: hasDeploy ? "deploy hook executable" : hasBoundHooks ? "hook IDs bound" : "deploy fallback configured",
    };
  }
  if (deployStatus === "exists-not-executable") {
    return {
      id: `repo-hooks.${repo.id}`,
      kind: "repo-hooks",
      label: `${repo.name} hooks`,
      status: "warn",
      detail: ".citadel/hooks/deploy exists but is not executable",
      hint: `chmod +x ${repo.rootPath}/.citadel/hooks/deploy`,
    };
  }
  return {
    id: `repo-hooks.${repo.id}`,
    kind: "repo-hooks",
    label: `${repo.name} hooks`,
    status: "warn",
    detail: "no hooks bound and no deploy hook file",
    hint: `scaffold with AI — open /settings/repos/${repo.id} and click "Scaffold with AI"`,
  };
}

async function checkProviders(
  config: DoctorConfig,
  deps: DoctorDeps,
  binariesAvailable: Map<string, boolean>,
): Promise<DoctorCheck[]> {
  const health = await deps.collectProviderHealth();
  const byId = new Map(health.map((h) => [h.provider, h.status] as const));
  const checks: DoctorCheck[] = [];
  for (const [id, settings] of Object.entries(config.providers) as Array<
    [string, { enabled: boolean; command: string }]
  >) {
    const binaryPresent = binariesAvailable.get(settings.command) ?? null;
    const enabled = settings.enabled;
    const status = byId.get(id) ?? "unknown";
    if (!enabled || binaryPresent === false) {
      const reason = !enabled ? "provider disabled in config" : `command "${settings.command}" not found in PATH`;
      checks.push({
        id: `provider.${id}`,
        kind: "provider",
        label: `${id} provider`,
        status: "warn",
        detail: reason,
        hint: `provider unconfigured — ${id} features disabled (${reason})`,
      });
      continue;
    }
    if (status === "healthy" || status === "degraded") {
      checks.push({
        id: `provider.${id}`,
        kind: "provider",
        label: `${id} provider`,
        status: "ok",
        detail: `health: ${status}`,
      });
      continue;
    }
    checks.push({
      id: `provider.${id}`,
      kind: "provider",
      label: `${id} provider`,
      status: "fail",
      detail: `configured but unreachable (status: ${status})`,
      hint: `confirm ${settings.command} is authenticated and able to reach its remote`,
    });
  }
  return checks;
}

function checkBindHostTls(config: DoctorConfig): DoctorCheck {
  const loopback = LOOPBACK_HOSTS.has(config.bindHost);
  const tlsActive = config.tls != null;
  if (loopback || tlsActive) {
    return {
      id: "config.bind-host-tls",
      kind: "config",
      label: "bind-host / TLS",
      status: "ok",
      detail: `bindHost=${config.bindHost}, tls=${tlsActive ? "on" : "off"}`,
    };
  }
  return {
    id: "config.bind-host-tls",
    kind: "config",
    label: "bind-host / TLS",
    status: "warn",
    detail: `bindHost=${config.bindHost} is non-loopback but TLS is not configured`,
    hint: "set config.tls={certPath,keyPath} to enable HTTPS for LAN/Tailscale exposure",
  };
}

async function checkAgentRuntimes(config: DoctorConfig, deps: DoctorDeps): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  if (config.agentRuntimes.length === 0) {
    return [
      {
        id: "agent-runtime.available",
        kind: "agent-runtime",
        label: "agent runtimes",
        status: "fail",
        detail: "no agent runtimes configured",
        hint: "configure at least one agent runtime before launching agents",
      },
    ];
  }

  let executableCount = 0;
  for (const runtime of config.agentRuntimes) {
    const found = await deps.which(runtime.command);
    if (found) executableCount++;
    checks.push({
      id: `agent-runtime.${runtime.id}`,
      kind: "agent-runtime",
      label: runtime.displayName,
      status: found ? "ok" : "warn",
      detail: found ? found : `command "${runtime.command}" not found in PATH`,
      hint: found ? undefined : `install ${runtime.command} or update this agent runtime in Settings`,
    });
  }

  checks.push({
    id: "agent-runtime.available",
    kind: "agent-runtime",
    label: "executable agent runtime",
    status: executableCount > 0 ? "ok" : "fail",
    detail:
      executableCount > 0
        ? `${executableCount}/${config.agentRuntimes.length} configured agent runtimes executable`
        : "no configured agent runtime command is executable",
    hint: executableCount > 0 ? undefined : "install or configure at least one executable agent runtime",
  });
  return checks;
}

async function checkTerminal(config: DoctorConfig, deps: DoctorDeps): Promise<DoctorCheck> {
  const found = await deps.which(config.terminal.command);
  return {
    id: "terminal.command",
    kind: "terminal",
    label: config.terminal.displayName,
    status: found ? "ok" : "fail",
    detail: found ? found : `command "${config.terminal.command}" not found in PATH`,
    hint: found ? undefined : "configure a valid terminal command before opening terminal tabs",
  };
}

async function checkSystemd(deps: DoctorDeps): Promise<DoctorCheck[]> {
  const services = await deps.listSystemdServices();
  if (!services.available) {
    return [
      {
        id: "service.citadel",
        kind: "service",
        label: "citadel.service",
        status: "skipped",
        detail: "systemd --user not available (worktree dev mode)",
      },
      {
        id: "service.citadel-tmux",
        kind: "service",
        label: "citadel-tmux.service",
        status: "skipped",
        detail: "systemd --user not available (worktree dev mode)",
      },
    ];
  }
  return [
    { id: "service.citadel", kind: "service", label: "citadel.service", status: services.citadel },
    { id: "service.citadel-tmux", kind: "service", label: "citadel-tmux.service", status: services.tmux },
  ];
}

export async function runDoctorChecks(input: {
  config: DoctorConfig;
  mode: "cli" | "daemon";
  deps: DoctorDeps;
}): Promise<DoctorReport> {
  const { config, mode, deps } = input;
  const checks: DoctorCheck[] = [];

  const binaryChecks = await checkBinaries(deps, mode);
  checks.push(...binaryChecks);
  const binariesAvailable = new Map<string, boolean>();
  for (const c of binaryChecks) {
    const bin = c.id.replace(/^binary\./, "");
    binariesAvailable.set(bin, c.status === "ok");
  }

  if (mode === "cli") {
    checks.push(...(await checkSystemd(deps)));
    checks.push(await checkDaemonReachability(config, deps));
  }

  checks.push(checkBindHostTls(config));
  checks.push(...(await checkAgentRuntimes(config, deps)));
  checks.push(await checkTerminal(config, deps));
  checks.push(await checkSchemaVersion("(daemon-owned)", deps));

  for (const repo of deps.listRepos()) {
    checks.push(checkRepoHooks(repo, deps));
  }

  checks.push(...(await checkProviders(config, deps, binariesAvailable)));

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    summary: summarizeDoctor(checks),
    protocol: config.tls ? "https" : "http",
    bindUrl: `${config.tls ? "https" : "http"}://${config.bindHost}:${config.port}`,
    checks,
  };
}
