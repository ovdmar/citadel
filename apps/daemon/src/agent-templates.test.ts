import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentTemplateNotFoundError,
  StaleAgentTemplateUpdatedAtError,
  listAgentTemplates,
  resetActionTemplate,
  resetRoleTemplate,
  updateActionTemplate,
  updateRoleTemplate,
} from "./agent-templates.js";

describe("agent template storage", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-agent-templates-"));
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("seeds exactly the five predefined roles and built-in actions", async () => {
    const roles = await listAgentTemplates(dataDir);

    expect(roles.map((role) => role.role)).toEqual(["pm", "architect", "implementation", "prototype", "manager"]);
    expect(roles.every((role) => role.builtIn && role.resettable)).toBe(true);
    expect(roles.find((role) => role.role === "implementation")?.actions.map((action) => action.id)).toEqual([
      "implementation.review_pr",
      "implementation.fix_ci",
      "implementation.fix_conflicts",
      "implementation.poke_idle_without_pr",
      "implementation.restack_checkout",
    ]);
  });

  it("updates and resets role templates with stale-write protection", async () => {
    const role = (await listAgentTemplates(dataDir)).find((entry) => entry.role === "architect");
    if (!role) throw new Error("expected architect role");

    const updated = await updateRoleTemplate(dataDir, "architect", {
      systemPrompt: "custom architect prompt",
      launchSettings: { runtimeId: "codex", model: "gpt-5.4", effort: "high", fastMode: null, contextMode: "max" },
      updatedAt: role.updatedAt ?? "",
    });

    expect(updated.systemPrompt).toBe("custom architect prompt");
    expect(updated.launchSettings.runtimeId).toBe("codex");
    await expect(
      updateRoleTemplate(dataDir, "architect", { systemPrompt: "stale", updatedAt: role.updatedAt ?? "" }),
    ).rejects.toBeInstanceOf(StaleAgentTemplateUpdatedAtError);

    const reset = await resetRoleTemplate(dataDir, "architect");
    expect(reset.systemPrompt).not.toBe("custom architect prompt");
    expect(reset.launchSettings.runtimeId).toBe("claude-code");
  });

  it("updates and resets built-in action templates without allowing custom actions through normalization", async () => {
    await listAgentTemplates(dataDir);
    const filePath = path.join(dataDir, "agent-templates.json");
    const stored = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
      roles: Array<{ role: string; actions: unknown[] }>;
    };
    stored.roles[0]?.actions.push({ id: "pm.custom", role: "pm", displayName: "Custom", prompt: "x" });
    fs.writeFileSync(filePath, JSON.stringify(stored));

    const roles = await listAgentTemplates(dataDir);
    expect(roles.find((role) => role.role === "pm")?.actions).toEqual([]);

    const review = roles.flatMap((role) => role.actions).find((action) => action.id === "implementation.review_pr");
    if (!review) throw new Error("expected review action");
    const updated = await updateActionTemplate(dataDir, "implementation.review_pr", {
      prompt: "custom review prompt",
      executionMode: "new_session",
      updatedAt: review.updatedAt ?? "",
    });
    expect(updated.prompt).toBe("custom review prompt");

    const reset = await resetActionTemplate(dataDir, "implementation.review_pr");
    expect(reset.prompt).not.toBe("custom review prompt");
  });

  it("throws for unknown predefined ids", async () => {
    await expect(resetRoleTemplate(dataDir, "not-a-role" as "pm")).rejects.toBeInstanceOf(AgentTemplateNotFoundError);
    await expect(resetActionTemplate(dataDir, "not.action" as "implementation.review_pr")).rejects.toBeInstanceOf(
      AgentTemplateNotFoundError,
    );
  });
});
