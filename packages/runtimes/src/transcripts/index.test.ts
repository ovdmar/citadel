import { describe, expect, it } from "vitest";
import { getTranscriptAdapter, getUserPromptsForSession } from "./index.js";

describe("transcript adapter dispatcher", () => {
  it("resolves an adapter for each supported runtime", () => {
    expect(getTranscriptAdapter("claude-code")?.runtimeId).toBe("claude-code");
    expect(getTranscriptAdapter("codex")?.runtimeId).toBe("codex");
    expect(getTranscriptAdapter("cursor-agent")?.runtimeId).toBe("cursor-agent");
  });

  it("returns null for unknown runtimes", () => {
    expect(getTranscriptAdapter("shell")).toBeNull();
  });

  it("returns an empty array when no adapter is registered", () => {
    expect(
      getUserPromptsForSession({
        runtimeId: "shell",
        workspacePath: "/tmp/x",
        sessionStartedAt: "2026-05-23T10:00:00.000Z",
      }),
    ).toEqual([]);
  });
});
