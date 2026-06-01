import { describe, expect, it } from "vitest";
import {
  ActionTemplateSchema,
  CreateWorkspaceCheckoutInputSchema,
  ExecutionTargetSchema,
  LaunchArchitectAgentInputSchema,
  LaunchImplementationAgentInputSchema,
  LaunchPmAgentInputSchema,
  LaunchSettingsSchema,
  MarkCheckoutReadyForReviewInputSchema,
  RegisterWorkspacePlanInputSchema,
  ReviewArtifactSchema,
  RoleTemplateSchema,
  RuntimeLaunchOptionCapabilitiesSchema,
  UpdateTicketStatusInputSchema,
  WorkspaceManagerSchema,
  WorkspacePlanVersionSchema,
  WorktreeCheckoutSchema,
} from "./index.js";

const timestamp = "2026-06-01T00:00:00.000Z";

describe("agents system contracts", () => {
  it("models predefined role and action templates without custom role ids", () => {
    const launchSettings = LaunchSettingsSchema.parse({
      runtimeId: "codex",
      model: "gpt-5.4",
      effort: "high",
      fastMode: false,
      contextMode: "max",
    });
    const action = ActionTemplateSchema.parse({
      id: "implementation.review_pr",
      role: "implementation",
      displayName: "Review PR",
      prompt: "Run review-pr.",
      launchSettings,
    });
    const role = RoleTemplateSchema.parse({
      role: "implementation",
      displayName: "Implementation",
      systemPrompt: "Implement the approved plan.",
      launchSettings,
      actions: [action],
    });

    expect(role.actions[0]?.executionMode).toBe("new_session");
    expect(ActionTemplateSchema.safeParse({ ...action, role: "manager" }).success).toBe(false);
    expect(RoleTemplateSchema.safeParse({ ...role, role: "custom" }).success).toBe(false);
  });

  it("models workspace targets, checkouts, plans, review artifacts, and manager state", () => {
    const checkout = WorktreeCheckoutSchema.parse({
      id: "co_1",
      workspaceId: "ws_1",
      repoId: "repo_1",
      name: "api",
      path: "/work/feature/api",
      branch: "feature/api",
      baseBranch: "main",
      issue: { provider: "jira", key: "CIT-1" },
      intendedPr: { provider: "github", number: 12, url: "https://example.test/pull/12" },
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const target = ExecutionTargetSchema.parse({
      type: "worktree_checkout",
      workspaceId: "ws_1",
      checkoutId: checkout.id,
      cwd: checkout.path,
    });
    const plan = WorkspacePlanVersionSchema.parse({
      id: "plan_1",
      workspaceId: "ws_1",
      version: 1,
      status: "approved",
      hash: "sha256-test",
      active: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const artifact = ReviewArtifactSchema.parse({
      id: "review_1",
      workspaceId: "ws_1",
      checkoutId: checkout.id,
      planVersionId: plan.id,
      prProvider: "github",
      headSha: "abc123",
      result: "approve",
      findingsStatus: "none",
      createdAt: timestamp,
    });
    const manager = WorkspaceManagerSchema.parse({
      id: "mgr_1",
      workspaceId: "ws_1",
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    expect(checkout.gateStatus).toBe("not_started");
    expect(target.type).toBe("worktree_checkout");
    expect(plan.approvalMode).toBe("manual");
    expect(artifact.blockingFindings).toEqual([]);
    expect(manager.pauseState).toBe("running");
  });

  it("validates launcher and MCP input contracts", () => {
    expect(LaunchPmAgentInputSchema.parse({ idea: "Build checkout automation" }).actor).toBe("mcp");
    expect(LaunchArchitectAgentInputSchema.parse({ workspaceId: "ws_1", planApprovalMode: "auto" }).actor).toBe("mcp");
    expect(LaunchImplementationAgentInputSchema.parse({ checkoutId: "co_1" }).checkoutId).toBe("co_1");
    expect(RegisterWorkspacePlanInputSchema.parse({ workspaceId: "ws_1", path: "/work/plan.md" }).status).toBe("draft");
    expect(
      CreateWorkspaceCheckoutInputSchema.parse({ workspaceId: "ws_1", repoId: "repo_1", name: "api", branch: "b" })
        .source,
    ).toBe("default_branch");
    expect(MarkCheckoutReadyForReviewInputSchema.parse({ checkoutId: "co_1" }).checkoutId).toBe("co_1");
    expect(
      UpdateTicketStatusInputSchema.parse({
        workspaceId: "ws_1",
        issue: { provider: "jira", key: "CIT-1" },
        targetState: "in_review",
      }).targetState,
    ).toBe("in_review");
    expect(
      RuntimeLaunchOptionCapabilitiesSchema.parse({
        runtimeId: "codex",
        models: [{ id: "gpt-5.4", label: "GPT-5.4", default: true }],
      }).defaultModel,
    ).toBeNull();
  });
});
