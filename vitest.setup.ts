import { execFileSync } from "node:child_process";

type VitestTmuxState = {
  ownsSocket: boolean;
  socket: string;
};

const globalState = globalThis as typeof globalThis & {
  __citadelVitestTmux?: VitestTmuxState;
};

if (!globalState.__citadelVitestTmux) {
  // Forked Vitest workers run tmux-backed tests in parallel, so each worker
  // gets its own socket instead of racing on the user's default tmux server.
  const configuredSocket = process.env.CITADEL_VITEST_TMUX_SOCKET || undefined;
  const socket = (configuredSocket || `citadel-vitest-${process.pid}`).replace(/[^A-Za-z0-9_.-]/g, "-");
  const state = { ownsSocket: configuredSocket === undefined, socket };
  globalState.__citadelVitestTmux = state;

  if (state.ownsSocket) {
    process.once("exit", () => {
      try {
        execFileSync("tmux", ["-L", state.socket, "kill-server"], { stdio: "ignore" });
      } catch {
        // No test tmux server was left running.
      }
    });
  }
}

process.env.CITADEL_TMUX_SOCKET = globalState.__citadelVitestTmux.socket;
