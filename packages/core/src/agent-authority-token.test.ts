import { describe, expect, it } from "vitest";
import {
  LaunchTextValidationError,
  assertNoRawAgentAuthorityToken,
  containsRawAgentAuthorityToken,
} from "./agent-authority-token.js";

describe("agent authority token launch text guard", () => {
  it("detects raw authority token shapes without matching ordinary text", () => {
    expect(containsRawAgentAuthorityToken("citadel_agent_authority_abcdefghijklmnopqrstuvwxyz0123456789")).toBe(true);
    expect(containsRawAgentAuthorityToken("this prompt mentions authority tokens generically")).toBe(false);
  });

  it("rejects with a sanitized component-only error", () => {
    const token = "citadel_agent_authority_abcdefghijklmnopqrstuvwxyz0123456789";

    let thrown: unknown;
    try {
      assertNoRawAgentAuthorityToken(`never store ${token}`, {
        component: "agentSessions.baseSystemPrompt",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(LaunchTextValidationError);
    expect((thrown as Error).message).toBe("raw_authority_token_present:agentSessions.baseSystemPrompt");
    expect((thrown as Error).message).not.toContain(token);
  });
});
