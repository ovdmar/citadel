import { defaultConfigPath, loadConfig, loadDevState, resolveWorktreeRoot, saveDevState } from "@citadel/config";
import { SqliteStore } from "@citadel/db";
import { OperationService } from "@citadel/operations";
import { createDaemonApp } from "./app.js";

// Resolve the worktree root before loading config. When running inside a
// Citadel checkout, env always wins over dev.json; dev.json wins over an
// error. The bare config default (4010) is reserved for the systemd-managed
// install — a checkout-launched daemon must never silently bind that port,
// or it will clobber the long-term service. The Makefile, the deploy hook,
// and the systemd unit all set CITADEL_PORT explicitly, so this guard only
// fires when someone runs `node dist/index.js` raw without setting up env.
const worktreeRoot = resolveWorktreeRoot();
const devState = worktreeRoot ? loadDevState(worktreeRoot) : null;
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
const store = new SqliteStore(config.databasePath);
store.migrate();
const operations = new OperationService(store, config);
operations.reconcile();
const { server } = await createDaemonApp({ config, configPath, store, operations });

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
});
