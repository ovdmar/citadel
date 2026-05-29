export class TtydUnavailableError extends Error {
  readonly code: "ttyd_missing" | "no_free_port" | "ttyd_start_timeout" | "tmux_session_missing" | "spawn_failed";

  constructor(code: TtydUnavailableError["code"], message: string) {
    super(message);
    this.code = code;
    this.name = "TtydUnavailableError";
  }
}
