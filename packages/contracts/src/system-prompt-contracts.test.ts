import { describe, expect, it } from "vitest";
import {
  AgentSessionSchema,
  CreateAgentSessionInputSchema,
  LaunchAgentInputSchema,
  SystemPromptDeliverySchema,
  SystemPromptSourceSchema,
} from "./index.js";

describe("system prompt contracts", () => {
  it("parses public caller prompts while rejecting trusted metadata writes", () => {
    expect(
      CreateAgentSessionInputSchema.parse({
        workspaceId: "ws_test",
        runtimeId: "codex",
        systemPrompt: "caller supplement",
      }).systemPrompt,
    ).toBe("caller supplement");
    expect(
      CreateAgentSessionInputSchema.safeParse({ workspaceId: "ws_test", runtimeId: "codex", systemPrompt: null })
        .success,
    ).toBe(false);
    expect(
      CreateAgentSessionInputSchema.safeParse({
        workspaceId: "ws_test",
        runtimeId: "codex",
        systemPromptSources: ["role_template"],
      }).success,
    ).toBe(false);
    expect(
      LaunchAgentInputSchema.parse({ repoName: "citadel", prompt: "Build it", systemPrompt: "Use Citadel tools." })
        .systemPrompt,
    ).toBe("Use Citadel tools.");
    expect(
      LaunchAgentInputSchema.safeParse({ repoName: "citadel", prompt: "Build it", systemPrompt: null }).success,
    ).toBe(false);
  });

  it("validates session source and delivery metadata", () => {
    const parsed = AgentSessionSchema.parse({
      id: "sess_test",
      kind: "agent",
      workspaceId: "ws_test",
      runtimeId: "claude-code",
      displayName: "Claude Code",
      status: "running",
      transport: "connected",
      tmuxSessionName: "citadel_test",
      tmuxSessionId: "$1",
      systemPromptSources: ["settings_base", "role_template"],
      systemPromptDelivery: { mode: "native_argv", runtimeId: "claude-code" },
      systemPromptLastDelivery: { mode: "native_argv", runtimeId: "claude-code" },
      createdAt: "2026-05-17T00:00:00.000Z",
      updatedAt: "2026-05-17T00:00:00.000Z",
    });
    expect(parsed.systemPromptSources).toEqual(["settings_base", "role_template"]);
    expect(parsed.systemPromptDelivery?.mode).toBe("native_argv");
  });

  it("validates delivery shape variants", () => {
    expect(SystemPromptSourceSchema.parse("settings_base")).toBe("settings_base");
    expect(SystemPromptSourceSchema.parse("role_template")).toBe("role_template");
    expect(SystemPromptSourceSchema.parse("caller")).toBe("caller");
    expect(SystemPromptSourceSchema.safeParse("client_claimed_role").success).toBe(false);
    expect(SystemPromptDeliverySchema.parse({ mode: "none", reason: "empty" })).toEqual({
      mode: "none",
      reason: "empty",
    });
    expect(SystemPromptDeliverySchema.parse({ mode: "native_argv", runtimeId: "claude-code" }).mode).toBe(
      "native_argv",
    );
    expect(SystemPromptDeliverySchema.parse({ mode: "pasted_wrapper", reason: "native_unavailable" }).mode).toBe(
      "pasted_wrapper",
    );
    expect(SystemPromptDeliverySchema.parse({ mode: "skipped_resume", reason: "resume" })).toMatchObject({
      reason: "resume",
    });
    expect(SystemPromptDeliverySchema.parse({ mode: "pasted_wrapper", reason: "argv_too_large" })).toMatchObject({
      reason: "argv_too_large",
    });
    expect(SystemPromptDeliverySchema.safeParse({ mode: "native_argv", reason: "resume" }).success).toBe(false);
  });
});
