export type TtydTheme = "light" | "dark";

export type TtydEntry = {
  key: string;
  port: number;
  pid: number;
  basePath: string;
  tmuxSession: string;
  worktreePath: string | null;
  startedAt: string;
  theme: TtydTheme;
  /**
   * Cockpit tab the entry belongs to. Sessions resumed inside the same tab
   * reuse the source row's tabId, so this enforces one ttyd per tabId and
   * recovers the right entry after a daemon restart.
   */
  tabId: string | null;
};

export type TtydDiagnosticsSink = {
  log(category: string, event: string, data?: Record<string, unknown>): void;
};

export type TtydManagerConfig = {
  ttydBin?: string;
  shellBin?: string;
  portBase?: number;
  portMax?: number;
  basePathPrefix?: string;
  readyTimeoutMs?: number;
  publicPath?: (key: string) => string;
  diagnostics?: TtydDiagnosticsSink;
};

export type TtydManager = {
  ensure(input: {
    key: string;
    tmuxSession: string;
    tabId?: string | null;
    worktreePath?: string | null;
    theme?: TtydTheme;
    force?: boolean;
    enableTmuxMouse?: boolean;
  }): Promise<TtydEntry>;
  lookup(key: string): TtydEntry | null;
  release(key: string): void;
  releaseTab(tabId: string): number;
  list(): TtydEntry[];
  cleanupStale(): { killed: number; portRange: [number, number] };
  adopt(
    records: TtydEntry[],
    resolveTabId?: (key: string) => string | null,
  ): { adopted: number; reapedDuplicates: number; reapedUnknown: number };
  shutdown(): void;
  config: Required<Omit<TtydManagerConfig, "publicPath" | "diagnostics">> &
    Pick<TtydManagerConfig, "publicPath" | "diagnostics">;
};

export class TtydUnavailableError extends Error {
  readonly code: "ttyd_missing" | "no_free_port" | "ttyd_start_timeout" | "tmux_session_missing" | "spawn_failed";
  constructor(code: TtydUnavailableError["code"], message: string) {
    super(message);
    this.code = code;
    this.name = "TtydUnavailableError";
  }
}
