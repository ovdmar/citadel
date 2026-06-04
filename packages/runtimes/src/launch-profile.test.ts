import { describe, expect, it } from "vitest";
import { resolveRuntimeLaunchProfile, runtimeLaunchOptionCapabilities } from "./launch-profile.js";

describe("runtime launch profiles", () => {
  const runtime = {
    id: "codex",
    displayName: "Codex",
    command: "codex",
    args: ["--yolo"],
    launchOptions: {
      models: [
        { id: "gpt-5.4", label: "GPT-5.4", default: true },
        { id: "old", label: "Old", deprecated: true },
      ],
      defaultModel: "gpt-5.4",
      effortValues: ["low", "medium", "high"],
      contextModes: ["standard", "max"],
      modelArgv: { argv: ["-m", "{value}"] },
      effortArgv: { argv: ["-c", "model_reasoning_effort={value}"] },
      contextArgv: { argv: ["-c", "model_context_window={value}"] },
    },
  };

  it("maps semantic model, effort, and context settings to runtime argv", () => {
    const profile = resolveRuntimeLaunchProfile({
      runtime,
      settings: {
        runtimeId: "codex",
        model: "gpt-5.4",
        effort: "high",
        fastMode: null,
        contextMode: "max",
      },
      now: () => "2026-01-01T00:00:00.000Z",
    });

    expect(profile.args).toEqual([
      "--yolo",
      "-m",
      "gpt-5.4",
      "-c",
      "model_reasoning_effort=high",
      "-c",
      "model_context_window=max",
    ]);
    expect(profile.launchWarnings).toEqual([]);
    expect(profile.capabilities.checkedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("falls back from unavailable or deprecated models and records warnings", () => {
    const profile = resolveRuntimeLaunchProfile({
      runtime,
      settings: {
        runtimeId: "codex",
        model: "old",
        effort: "extreme",
        fastMode: true,
        contextMode: "huge",
      },
    });

    expect(profile.args).toEqual(["--yolo", "-m", "gpt-5.4"]);
    expect(profile.launchWarnings).toEqual([
      "Runtime codex model old is unavailable; using gpt-5.4",
      "effort extreme is not supported; dropping effort",
      "Runtime codex does not support fast mode; dropping fastMode",
      "context mode huge is not supported; dropping context mode",
    ]);
  });

  it("surfaces static fallback capabilities for runtimes without launch options", () => {
    const capabilities = runtimeLaunchOptionCapabilities({ id: "pi" });

    expect(capabilities).toMatchObject({
      runtimeId: "pi",
      models: [],
      defaultModel: null,
      stale: false,
      reason: "static_fallback",
    });
  });
});
