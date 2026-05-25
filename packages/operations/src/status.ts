// Barrel for the new agent-status pipeline (reducer + monitor).
// Kept separate from index.ts so the main barrel stays under the 800-line
// file-size gate.
export { LAST_OUTPUT_DEBOUNCE_MS, reduceStatus } from "./agent-status.js";
export type { ReducerPrev, StatusSignal, StatusUpdate, TmuxMissingReason } from "./agent-status.js";
export { runStatusMonitorTick, startStatusMonitor } from "./status-monitor.js";
export type {
  MonitorSessionState,
  MonitorTickDeps,
  MonitorTickOptions,
  MonitorTickResult,
  SentinelReading,
  StatusMonitorHandle,
} from "./status-monitor.js";
