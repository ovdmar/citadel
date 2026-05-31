import { createHash } from "node:crypto";
import { defaultConfigPath, loadConfig, loadDevState, resolveWorktreeRoot, saveDevState } from "@citadel/config";
import { SqliteStore } from "@citadel/db";
import { OperationService } from "@citadel/operations";
import { ensureCitadelTmuxRunning, ensureWorktreeTmuxRunning } from "@citadel/terminal";
import { createDaemonApp } from "./app.js";
import { runBootRestore } from "./boot-restore.js";
import { shouldReapTmuxOrphans } from "./orphan-reaper-safety.js";
import { reapOrphans } from "./orphan-reaper.js";
import { setTmuxOwnership } from "./tmux-ownership.js";

// Resolve the worktree root before loading config. When running inside a
// Citadel checkout, env always wins over dev.json; dev.json wins over an
// error. The bare config default (4010) is reserved for the systemd-managed
// install — a checkout-launched daemon must never silently bind that port,
// or it will clobber the long-term service. The Makefile, the deploy hook,
// and the systemd unit all set CITADEL_PORT explicitly, so this guard only
// fires when someone runs `node dist/index.js` raw without setting up env.
const worktreeRoot = resolveWorktreeRoot();
const devState = worktreeRoot ? loadDevState(worktreeRoot) : null;
const explicitDataDirOverrideAtLaunch = process.env.CITADEL_DATA_DIR !== undefined;
// "Am I a worktree dev daemon?" is decided by an explicit positive signal
// (CITADEL_WORKTREE=1, set by `make deploy`), NOT by filesystem inspection.
// The main checkout that `make install` points the systemd unit at also has
// `.git/` and `.citadel/`, so `resolveWorktreeRoot()` alone can't tell prod
// apart from a dev worktree — and treating prod as a worktree would override
// the systemd unit's CITADEL_CONFIG / strand the prod data dir.
//
// When the positive signal IS set, hard-isolate from inherited env that
// could point outside this worktree (cockpit-under-systemd invoking `make
// deploy` leaks CITADEL_CONFIG=<prod>). The Makefile also `env -u`s these
// vars; the block below is defense in depth.
const isWorktreeDaemon = worktreeRoot !== null && process.env.CITADEL_WORKTREE === "1";
if (isWorktreeDaemon && worktreeRoot) {
  if (process.env.CITADEL_CONFIG && !process.env.CITADEL_CONFIG.startsWith(`${worktreeRoot}/`)) {
    console.warn(
      `Ignoring inherited CITADEL_CONFIG=${process.env.CITADEL_CONFIG} — points outside the worktree (${worktreeRoot}). Worktree daemons must use worktree-scoped config.`,
    );
    process.env.CITADEL_CONFIG = "";
  }
  const expectedDataDir = `${worktreeRoot}/.citadel/data`;
  if (process.env.CITADEL_DATA_DIR && !process.env.CITADEL_DATA_DIR.startsWith(`${worktreeRoot}/`)) {
    console.warn(
      `Ignoring inherited CITADEL_DATA_DIR=${process.env.CITADEL_DATA_DIR} — points outside the worktree (${worktreeRoot}). Using ${expectedDataDir} instead.`,
    );
    process.env.CITADEL_DATA_DIR = expectedDataDir;
  } else if (!process.env.CITADEL_DATA_DIR) {
    process.env.CITADEL_DATA_DIR = expectedDataDir;
  }
}
if (devState && !process.env.CITADEL_PORT) {
  process.env.CITADEL_PORT = String(devState.port);
}
if (isWorktreeDaemon && !process.env.CITADEL_PORT) {
  console.error(
    `Citadel daemon launched as a worktree daemon (${worktreeRoot}) without CITADEL_PORT set.\nRefusing to bind the systemd-reserved default (:4010).\nUse 'make deploy' from this checkout, or set CITADEL_PORT explicitly.`,
  );
  process.exit(2);
}

const configPath = defaultConfigPath();
const config = loadConfig(configPath);
const portOverride = Number.parseInt(process.env.CITADEL_PORT ?? "", 10);
if (Number.isFinite(portOverride) && portOverride > 0 && portOverride < 65536) config.port = portOverride;
if (process.env.CITADEL_BIND_HOST) config.bindHost = process.env.CITADEL_BIND_HOST;

if (
  !isWorktreeDaemon &&
  explicitDataDirOverrideAtLaunch &&
  process.env.CITADEL_TMUX_SOCKET === "citadel" &&
  process.env.CITADEL_ALLOW_SHARED_TMUX_SOCKET !== "1"
) {
  const suffix = createHash("sha1").update(`${config.dataDir}:${config.port}`).digest("hex").slice(0, 10);
  const isolatedSocket = `citadel-sandbox-${suffix}`;
  console.warn(
    `[tmux-guard] CITADEL_DATA_DIR=${config.dataDir} was launched with shared CITADEL_TMUX_SOCKET=citadel; isolating this daemon on ${isolatedSocket}. Set CITADEL_ALLOW_SHARED_TMUX_SOCKET=1 only for intentional shared-socket maintenance.`,
  );
  process.env.CITADEL_TMUX_SOCKET = isolatedSocket;
  process.env.CITADEL_OWN_TMUX_SOCKET = "1";
}
const store = new SqliteStore(config.databasePath);
store.migrate();
const operations = new OperationService(store, config);
operations.reconcile();
const daemon = await createDaemonApp({ config, configPath, store, operations });
const { server } = daemon;

// Try to bind; on EADDRINUSE, walk the next 10 ports so worktree-derived ports
// that happen to collide (cksum-mod-100 birthday hits at ~15 worktrees) don't
// silently kill the daemon. Persist the chosen port to .citadel/dev.json so
// the cockpit's Redeploy chip and the Makefile both advertise the right URL.
const MAX_PORT_PROBES = 10;
let probes = 0;

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code !== "EADDRINUSE" || probes >= MAX_PORT_PROBES) {
    console.error(`Citadel daemon failed to bind: ${error.message}`);
    process.exit(1);
  }
  probes += 1;
  const next = config.port + 1;
  console.warn(`Port ${config.port} in use, trying ${next}…`);
  config.port = next;
  setImmediate(() => server.listen(config.port, config.bindHost));
});

server.listen(config.port, config.bindHost, () => {
  console.log(`Citadel daemon listening on http://${config.bindHost}:${config.port}`);
  console.log(`  data dir: ${config.dataDir}`);
  if (isWorktreeDaemon && worktreeRoot) {
    console.log(`  worktree: ${worktreeRoot}`);
    saveDevState(worktreeRoot, {
      port: config.port,
      host: config.bindHost,
      worktreePath: worktreeRoot,
      ...(devState?.webPort ? { webPort: devState.webPort } : {}),
    });
  }
  // Tmux ownership probe + auto-start. Two paths, decided by socket ownership:
  //   - Prod (systemd): citadel-tmux.service owns a single shared `citadel`
  //     socket. The daemon kicks the unit up if absent, and reports orphan
  //     ownership (someone ran `tmux -L citadel` outside the unit) without
  //     killing — every live agent pane lives in that server.
  //   - Worktree: the daemon owns a per-checkout socket (CITADEL_TMUX_SOCKET=
  //     citadel-w-<hash>, set by `make deploy`). Spawned detached so HMR
  //     restarts of the daemon don't kill agent panes. Per-worktree isolation
  //     means the orphan-reaper can never SIGKILL prod's sessions.
  const requestedOwnedSocket =
    process.env.CITADEL_OWN_TMUX_SOCKET === "1" &&
    Boolean(process.env.CITADEL_TMUX_SOCKET) &&
    process.env.CITADEL_TMUX_SOCKET !== "citadel";
  const ownsTmuxSocket = isWorktreeDaemon || requestedOwnedSocket;

  if (ownsTmuxSocket) {
    const socket = process.env.CITADEL_TMUX_SOCKET ?? "";
    ensureWorktreeTmuxRunning(socket)
      .then((ownership) => {
        setTmuxOwnership(ownership);
      })
      .catch((error) => {
        console.warn(
          `[tmux-guard] worktree tmux start failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  } else {
    ensureCitadelTmuxRunning()
      .then((ownership) => {
        setTmuxOwnership(ownership);
        if (ownership.kind === "absent") {
          console.warn(
            "[tmux-guard] citadel-tmux.service is absent after start attempt — agent spawns will fail until it's up",
          );
        } else if (ownership.kind === "orphan") {
          console.warn(
            `[tmux-guard] orphan tmux server holding socket (pid=${ownership.pid}, supervised=${ownership.supervisedPid ?? "none"}) — run \`make tmux-service\` to reconcile (destructive: restarts all agents)`,
          );
        }
      })
      .catch((error) => {
        console.warn(`[tmux-guard] probe failed: ${error instanceof Error ? error.message : String(error)}`);
      });
  }

  // Boot-time auto-restore. Fires once after listen() succeeds — the
  // cockpit polls /api/state.bootRestore for the running summary while we
  // walk the candidate list. Skipped when CITADEL_DISABLE_BOOT_RESTORE=1
  // for operators who want a quiet boot.
  if (process.env.CITADEL_DISABLE_BOOT_RESTORE !== "1") {
    runBootRestore({ store, operations, config, emit: daemon.emit, diagnostics: daemon.diagnostics })
      .catch((error) => {
        console.warn(`Boot-restore failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(async () => {
        // One-shot orphan reaper. Runs once boot-restore has had a chance to
        // re-spawn the recoverable sessions — anything still on the tmux
        // socket without a DB row at this point is an actual orphan from a
        // prior crash, safe to kill. Sequencing matters: doing this BEFORE
        // boot-restore could kill a tmux session right as boot-restore is
        // about to claim its name.
        try {
          const summary = await reapOrphans({
            store,
            diagnostics: daemon.diagnostics,
            reapTmuxSessions: shouldReapTmuxOrphans({
              daemonPort: config.port,
              explicitDataDirOverride: explicitDataDirOverrideAtLaunch,
              ownsTmuxSocket,
              disableOrphanReaper: process.env.CITADEL_DISABLE_ORPHAN_REAPER,
              allowSharedTmuxReaper: process.env.CITADEL_ALLOW_SHARED_TMUX_REAPER,
            }),
          });
          if (summary.tmuxReaped.length > 0) {
            console.log(`[orphan-reaper] tmux=${summary.tmuxReaped.length}`);
          }
          daemon.diagnostics.log("reaper", "orphan.done", {
            tmuxReaped: summary.tmuxReaped,
          });
        } catch (error) {
          console.warn(`Orphan reaper failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
  }
});
