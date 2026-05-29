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
   * (e.g. `claude --resume <uuid>`) reuse the source row's tabId — we use
   * that here to enforce one ttyd per tabId and to recover the right entry
   * after a daemon restart. `null` for the legacy adoption path when we
   * don't have a DB row to resolve the owning tab.
   */
  tabId: string | null;
};
