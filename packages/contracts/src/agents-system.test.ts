import { describe, expect, it } from "vitest";
import {
  ActionTemplateSchema,
  AgentToolAuthoritySchema,
  CheckoutCheckFactSchema,
  CheckoutGateSnapshotSchema,
  CheckoutNameSchema,
  CheckoutPrFactSchema,
  CreateWorkspaceCheckoutInputSchema,
  DeliveryUnitKeySchema,
  ExecutionTargetSchema,
  GitBranchNameSchema,
  IssueTransitionAttemptSchema,
  LaunchArchitectAgentInputSchema,
  LaunchImplementationAgentInputSchema,
  LaunchPmAgentInputSchema,
  LaunchSettingsSchema,
  LocalNotificationEventSchema,
  ManagerActionLedgerEntrySchema,
  MarkCheckoutReadyForReviewInputSchema,
  ProviderIssueFactSchema,
  RegisterCheckoutReviewArtifactInputSchema,
  RegisterWorkspacePlanInputSchema,
  ReviewArtifactSchema,
  RoleTemplateSchema,
  RuntimeLaunchOptionCapabilitiesSchema,
  StructuredLaunchOptionSchema,
  UpdateActionTemplateInputSchema,
  UpdateRoleTemplateInputSchema,
  UpdateTicketStatusInputSchema,
  WorkspaceManagerSchema,
  WorkspacePlanDeliveryUnitsBlockSchema,
  WorkspacePlanVersionSchema,
  WorktreeCheckoutSchema,
  isSafeCheckoutName,
  isSafeGitBranchName,
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
    expect(UpdateRoleTemplateInputSchema.parse({ systemPrompt: "new", updatedAt: timestamp }).systemPrompt).toBe("new");
    expect(
      UpdateActionTemplateInputSchema.parse({ executionMode: "existing_session", updatedAt: timestamp }).executionMode,
    ).toBe("existing_session");
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
    expect(checkout.intendedPr).toMatchObject({
      checksGreen: null,
      mergeStateStatus: null,
      hasConflicts: null,
    });
    expect(checkout.intendedPr?.state).toBeUndefined();
    expect(target.type).toBe("worktree_checkout");
    expect(plan.approvalMode).toBe("manual");
    expect(artifact.blockingFindings).toEqual([]);
    expect(artifact.invalidatedAt).toBeUndefined();
    expect(manager.pauseState).toBe("running");
  });

  it("validates delivery units, dependency edges, branch refs, and checkout names", () => {
    expect(isSafeCheckoutName("api-gate")).toBe(true);
    expect(isSafeCheckoutName("../api")).toBe(false);
    expect(isSafeCheckoutName("home")).toBe(false);
    expect(isSafeGitBranchName("feature/api-gate")).toBe(true);
    expect(isSafeGitBranchName("refs/heads/main")).toBe(false);
    expect(isSafeGitBranchName("bad..branch")).toBe(false);
    expect(DeliveryUnitKeySchema.safeParse("api.gate-1").success).toBe(true);
    expect(CheckoutNameSchema.safeParse("api/gate").success).toBe(false);
    expect(GitBranchNameSchema.safeParse("feature/api gate").success).toBe(false);

    const parsed = WorkspacePlanDeliveryUnitsBlockSchema.parse({
      deliveryUnits: [
        {
          key: "api-gate",
          repoName: "citadel",
          checkoutName: "api-gate",
          branch: "feature/api-gate",
          childIssue: { provider: "jira", key: "CIT-1" },
          dependencies: [],
        },
        {
          key: "web-gate",
          repoName: "citadel",
          checkoutName: "web-gate",
          branch: "feature/web-gate",
          childIssue: { provider: "jira", key: "CIT-2" },
          dependencies: [{ fromUnitKey: "api-gate", type: "stacked_on_pr" }],
        },
      ],
    });

    expect(parsed.deliveryUnits[1]?.dependencies[0]?.type).toBe("stacked_on_pr");
    expect(
      WorkspacePlanDeliveryUnitsBlockSchema.safeParse({
        deliveryUnits: [
          {
            key: "api-gate",
            repoName: "citadel",
            checkoutName: "api-gate",
            branch: "feature/api-gate",
            dependencies: [{ fromUnitKey: "api-gate" }],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      WorkspacePlanDeliveryUnitsBlockSchema.safeParse({
        deliveryUnits: [
          { key: "dup", repoName: "citadel", checkoutName: "one", branch: "feature/one" },
          { key: "dup", repoName: "citadel", checkoutName: "two", branch: "feature/two" },
        ],
      }).success,
    ).toBe(false);
  });

  it("models manager ledger, gate snapshots, launch options, notifications, provider facts, and authorities", () => {
    const action = ManagerActionLedgerEntrySchema.parse({
      id: "act_1",
      workspaceId: "ws_1",
      checkoutId: "co_1",
      managerId: "mgr_1",
      actionName: "launch_implementation",
      status: "claimed",
      scopeKey: "ws_1:plan_1:api",
      actionKey: "launch_implementation",
      idempotencyKey: "ws_1:plan_1:api:launch_implementation",
      leaseOwnerId: "daemon-a",
      leaseGeneration: 2,
      attemptCount: 1,
      planVersionId: "plan_1",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    expect(action.maxAttempts).toBe(3);

    const artifact = ReviewArtifactSchema.parse({
      id: "review_1",
      workspaceId: "ws_1",
      checkoutId: "co_1",
      planVersionId: "plan_1",
      prProvider: "github",
      headSha: "abc123",
      result: "request_changes",
      findingsStatus: "open_blocking",
      invalidatedAt: timestamp,
      invalidatedReason: "head_changed",
      createdAt: timestamp,
    });
    const gate = CheckoutGateSnapshotSchema.parse({
      workspaceId: "ws_1",
      checkoutId: "co_1",
      planVersionId: "plan_1",
      status: "review_blocked",
      refreshedAt: timestamp,
      reasons: [{ code: "blocking_review_findings", message: "Review has blocking findings" }],
      staleReviewArtifacts: [artifact],
      deviations: [],
    });
    expect(gate.providerFreshness.stale).toBe(false);
    expect(gate.staleReviewArtifacts[0]?.invalidatedReason).toBe("head_changed");

    expect(
      StructuredLaunchOptionSchema.parse({
        id: "implementation",
        enabled: false,
        reason: "Active plan required",
        severity: "blocking",
        role: "implementation",
        targetType: "worktree_checkout",
        actionName: "launch_implementation_agent",
      }).payload,
    ).toEqual({});

    expect(
      LocalNotificationEventSchema.parse({
        id: "note_1",
        workspaceId: "ws_1",
        checkoutId: "co_1",
        type: "human_input_needed",
        title: "Input needed",
        message: "Plan has no delivery units",
        dedupeKey: "ws_1:plan_1:no-delivery-units",
        triggeringFactFingerprint: "plan_1:no-delivery-units",
        createdAt: timestamp,
        updatedAt: timestamp,
      }).status,
    ).toBe("active");

    const identity = {
      providerType: "jira",
      providerInstanceId: "jira-primary",
      accountId: "acct-1",
      hostUrl: "https://jira.example.test",
      externalUrl: "https://jira.example.test/browse/CIT-1",
      workspaceBindingId: "binding_1",
      sourceBindingType: "checkout_child_issue" as const,
      sourceBindingId: "co_1",
    };
    expect(
      ProviderIssueFactSchema.parse({
        id: "issue_fact_1",
        workspaceId: "ws_1",
        checkoutId: "co_1",
        identity,
        issueKey: "CIT-1",
        fetchedAt: timestamp,
      }).identity.providerInstanceId,
    ).toBe("jira-primary");
    expect(
      IssueTransitionAttemptSchema.parse({
        id: "transition_1",
        workspaceId: "ws_1",
        checkoutId: "co_1",
        identity,
        issueKey: "CIT-1",
        requestedInternalState: "in_review",
        success: false,
        degradedReason: "transition_unavailable",
        createdAt: timestamp,
      }).success,
    ).toBe(false);

    const prIdentity = { ...identity, providerType: "github", sourceBindingType: "checkout_pr" as const };
    expect(
      CheckoutPrFactSchema.parse({
        id: "pr_fact_1",
        workspaceId: "ws_1",
        checkoutId: "co_1",
        identity: { ...prIdentity, repositoryId: "repo_1", providerRepositoryKey: "org/repo" },
        prNumber: 12,
        prUrl: "https://github.example.test/org/repo/pull/12",
        headSha: "abc123",
        baseRef: "main",
        fetchedAt: timestamp,
      }).identity.providerRepositoryKey,
    ).toBe("org/repo");
    expect(
      CheckoutCheckFactSchema.parse({
        id: "check_fact_1",
        workspaceId: "ws_1",
        checkoutId: "co_1",
        identity: { ...prIdentity, repositoryId: "repo_1", providerRepositoryKey: "org/repo" },
        headSha: "abc123",
        name: "ci",
        status: "completed",
        conclusion: "success",
        fetchedAt: timestamp,
      }).name,
    ).toBe("ci");

    expect(
      AgentToolAuthoritySchema.parse({
        id: "auth_1",
        tokenHash: "x".repeat(64),
        sessionId: "sess_1",
        role: "implementation",
        actionId: "implementation.review_pr",
        checkoutId: "co_1",
        planVersionId: "plan_1",
        managerActionId: "act_1",
        allowedToolNames: ["register_checkout_review_artifact"],
        issuedAt: timestamp,
        expiresAt: "2026-06-01T00:15:00.000Z",
        createdAt: timestamp,
        updatedAt: timestamp,
      }).revokedAt,
    ).toBeNull();
  });

  it("validates launcher and MCP input contracts", () => {
    expect(LaunchPmAgentInputSchema.parse({ idea: "Build checkout automation", actor: "human" })).toEqual({
      idea: "Build checkout automation",
    });
    expect(LaunchArchitectAgentInputSchema.parse({ workspaceId: "ws_1", planApprovalMode: "auto" })).toEqual({
      workspaceId: "ws_1",
      planApprovalMode: "auto",
    });
    expect(LaunchImplementationAgentInputSchema.parse({ checkoutId: "co_1" }).checkoutId).toBe("co_1");
    expect(RegisterWorkspacePlanInputSchema.parse({ workspaceId: "ws_1", path: "/work/plan.md" }).status).toBe("draft");
    expect(
      CreateWorkspaceCheckoutInputSchema.parse({ workspaceId: "ws_1", repoId: "repo_1", name: "api", branch: "b" })
        .source,
    ).toBe("default_branch");
    expect(
      MarkCheckoutReadyForReviewInputSchema.parse({
        checkoutId: "co_1",
        pr: { provider: "github", number: 12, headSha: "abc123" },
        notes: "implementation complete",
      }).pr?.headSha,
    ).toBe("abc123");
    expect(
      RegisterCheckoutReviewArtifactInputSchema.parse({
        checkoutId: "co_1",
        managerActionId: "act_1",
        result: "approve",
        findingsStatus: "none",
        blockingFindings: [],
        artifactPath: "/tmp/review.md",
      }).result,
    ).toBe("approve");
    expect(
      RegisterCheckoutReviewArtifactInputSchema.safeParse({
        checkoutId: "co_1",
        result: "approve",
        findingsStatus: "waived",
      }).success,
    ).toBe(false);
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
