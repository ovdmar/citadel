import { describe, expect, it } from "vitest";
import { ApiError } from "../api.js";
import { classifyRedeployError, watchdogShouldClear } from "./use-redeploy-helpers.js";

describe("classifyRedeployError", () => {
  it("treats ApiError with HTTP status as 'other' (honest 4xx/5xx, no MIN_SPIN_MS masking)", () => {
    expect(classifyRedeployError(new ApiError("invalid_app_name", [], undefined, 400))).toBe("other");
    expect(classifyRedeployError(new ApiError("deploy_hook_exit_2", [], undefined, 500))).toBe("other");
  });

  it("treats TypeError as 'network' (matches browser fetch's failed-network signature)", () => {
    const err = new TypeError("Failed to fetch");
    expect(classifyRedeployError(err)).toBe("network");
  });

  it("treats AbortError as 'network' (covers fetch aborts mid-flight, e.g. daemon restart)", () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    expect(classifyRedeployError(err)).toBe("network");
  });

  it("treats messages containing 'network'/'failed to fetch'/'fetch failed' as 'network'", () => {
    expect(classifyRedeployError(new Error("network error"))).toBe("network");
    expect(classifyRedeployError(new Error("fetch failed: ECONNRESET"))).toBe("network");
    expect(classifyRedeployError(new Error("Failed to fetch"))).toBe("network");
  });

  it("treats unknown errors as 'other' (conservative — surface them rather than hiding behind watchdog)", () => {
    expect(classifyRedeployError(new Error("something weird"))).toBe("other");
    expect(classifyRedeployError("a string")).toBe("other");
    expect(classifyRedeployError(undefined)).toBe("other");
  });
});

describe("watchdogShouldClear", () => {
  it("returns false on any null/missing current token (poll still in flight or daemon not ready)", () => {
    expect(watchdogShouldClear("2026-05-26T00:00:00.000Z", null)).toBe(false);
    expect(watchdogShouldClear("2026-05-26T00:00:00.000Z", undefined)).toBe(false);
    expect(watchdogShouldClear(null, null)).toBe(false);
  });

  it("returns false when current == pre (old daemon's last gasp during shutdown)", () => {
    const t = "2026-05-26T00:00:00.000Z";
    expect(watchdogShouldClear(t, t)).toBe(false);
  });

  it("returns true when current is strictly newer than pre (new daemon answered)", () => {
    expect(watchdogShouldClear("2026-05-26T00:00:00.000Z", "2026-05-26T00:00:00.001Z")).toBe(true);
  });

  it("returns false when current is older than pre (clock skew or polled the wrong daemon)", () => {
    expect(watchdogShouldClear("2026-05-26T00:00:01.000Z", "2026-05-26T00:00:00.000Z")).toBe(false);
  });

  it("clears on any successful poll when the pre-fetch failed (null pre-token)", () => {
    expect(watchdogShouldClear(null, "2026-05-26T00:00:00.000Z")).toBe(true);
  });
});
