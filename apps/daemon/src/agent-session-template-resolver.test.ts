import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCreateAgentSessionInputFromTemplates } from "./agent-session-template-resolver.js";
import { agentTemplateDefaultsFromRuntimes, listAgentTemplates } from "./agent-templates.js";
import { createFixture } from "./app-test-helpers.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("agent session template resolver", () => {
  it("derives role prompts and launch settings from the Agents tab template", async () => {
    const fixture = createFixture(dirs);
    const pm = (
      await listAgentTemplates(fixture.config.dataDir, agentTemplateDefaultsFromRuntimes(fixture.config.agentRuntimes))
    ).find((template) => template.role === "pm");
    if (!pm) throw new Error("expected PM template");

    const resolved = await resolveCreateAgentSessionInputFromTemplates(fixture.config, {
      workspaceId: "ws_test",
      runtimeId: "caller-runtime",
      role: "pm",
      displayName: "Caller label",
      launchSettings: { runtimeId: "caller-runtime", model: "caller", effort: null, fastMode: null, contextMode: null },
    });

    expect(resolved).toMatchObject({
      runtimeId: pm.launchSettings.runtimeId,
      displayName: pm.displayName,
      launchSettings: pm.launchSettings,
      roleTemplatePrompt: pm.systemPrompt,
    });
  });
});
