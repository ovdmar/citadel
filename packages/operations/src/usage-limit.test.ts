import type { AgentSession } from "@citadel/contracts";
import { describe, expect, it } from "vitest";
import { deriveAccountUsageLimit, parseUsageLimitResetFromReason } from "./usage-limit.js";

function session(over: Partial<AgentSession>): AgentSession {
  return {
    id: "sess-1",
    workspaceId: "ws-1",
    runtimeId: "claude-code",
    displayName: "Claude",
    status: "idle",
    statusReason: null,
    lastStatusAt: "2026-05-26T04:00:00.000Z",
    lastOutputAt: null,
    endedAt: null,
    exitCode: null,
    transport: "connected",
    tmuxSessionName: "tmux-sess-1",
    tmuxSessionId: "$1",
    runtimeSessionId: "uuid-1",
    createdAt: "2026-05-26T03:00:00.000Z",
    updatedAt: "2026-05-26T04:00:00.000Z",
    ...over,
  } satisfies AgentSession;
}

describe("parseUsageLimitResetFromReason", () => {
  it("extracts the iso timestamp from `pane:usage_limited:reset=<iso>`", () => {
    expect(parseUsageLimitResetFromReason("pane:usage_limited:reset=2026-05-26T07:50:00.000Z")).toBe(
      "2026-05-26T07:50:00.000Z",
    );
  });

  it("returns null for `reset=unknown` sentinel", () => {
    expect(parseUsageLimitResetFromReason("pane:usage_limited:reset=unknown")).toBeNull();
  });

  it("returns null for unrelated reason strings", () => {
    expect(parseUsageLimitResetFromReason("pane:rate_limited:server")).toBeNull();
    expect(parseUsageLimitResetFromReason("pane:active:idle")).toBeNull();
    expect(parseUsageLimitResetFromReason(null)).toBeNull();
    expect(parseUsageLimitResetFromReason(undefined)).toBeNull();
  });

  it("returns null when the embedded value isn't a parseable date", () => {
    expect(parseUsageLimitResetFromReason("pane:usage_limited:reset=not-a-date")).toBeNull();
  });
});

describe("deriveAccountUsageLimit", () => {
  const now = new Date("2026-05-26T05:00:00.000Z");

  it("returns null when no session is usage_limited", () => {
    expect(deriveAccountUsageLimit([session({ status: "idle", statusReason: "pane:active:idle" })], now)).toBeNull();
  });

  it("returns the latest still-future resetAt across multiple usage_limited sessions", () => {
    const sessions = [
      session({
        id: "a",
        status: "usage_limited",
        statusReason: "pane:usage_limited:reset=2026-05-26T07:50:00.000Z",
      }),
      session({
        id: "b",
        status: "usage_limited",
        statusReason: "pane:usage_limited:reset=2026-05-26T09:15:00.000Z",
      }),
    ];
    expect(deriveAccountUsageLimit(sessions, now)).toEqual({ resetAt: "2026-05-26T09:15:00.000Z" });
  });

  it("ignores resets that have already passed (those sessions are due to wake)", () => {
    const sessions = [
      session({
        id: "a",
        status: "usage_limited",
        statusReason: "pane:usage_limited:reset=2026-05-26T04:00:00.000Z",
      }),
    ];
    expect(deriveAccountUsageLimit(sessions, now)).toBeNull();
  });

  it("returns a 1-min holdover when a usage_limited session has unknown reset", () => {
    const sessions = [session({ status: "usage_limited", statusReason: "pane:usage_limited:reset=unknown" })];
    const result = deriveAccountUsageLimit(sessions, now);
    if (result === null) throw new Error("expected non-null AccountRateLimitInfo");
    expect(Date.parse(result.resetAt) - now.getTime()).toBe(60_000);
  });
});
