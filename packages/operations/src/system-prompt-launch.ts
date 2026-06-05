import { Buffer } from "node:buffer";
import type {
  CreateAgentSessionInput,
  SystemPromptDelivery,
  SystemPromptSource,
  WorkspaceSession,
} from "@citadel/contracts";
import { assertNoRawAgentAuthorityToken } from "@citadel/core";
import { type SystemPromptArgvMapping, renderSystemPromptArgv } from "@citadel/runtimes";

const MAX_SYSTEM_PROMPT_ARGV_SEGMENT_BYTES = 64 * 1024;
const MAX_AGENT_PROCESS_ARGV_BYTES = 128 * 1024;

export type CreateAgentSessionOperationInput = CreateAgentSessionInput & {
  roleTemplatePrompt?: string | null | undefined;
  systemPromptMode?: "default" | "none" | undefined;
  resumeSourceSessionId?: string | undefined;
};

export type SystemPromptStore = {
  listWorkspaceSessions(workspaceId: string): WorkspaceSession[];
  getWorkspaceSessionSystemPromptSnapshot(sessionId: string): string | null;
};

export type SystemPromptRuntimeArgvShape = {
  promptArg?: string | null | undefined;
  sessionIdArg?: string | null | undefined;
  resumeArg?: string | null | undefined;
};

export type SystemPromptState = {
  value: string | null;
  snapshot: string | null;
  sources: SystemPromptSource[] | null;
  initialDelivery: SystemPromptDelivery | null;
  lastDelivery: SystemPromptDelivery;
};

export type SystemPromptLaunchResolution = {
  state: SystemPromptState;
  runtimeArgs: string[];
  launchWarnings: string[];
  systemPromptDelivery: SystemPromptDelivery | null;
  systemPromptLastDelivery: SystemPromptDelivery;
  shouldUseFallbackSystemPrompt: boolean;
};

export function resolveSystemPromptLaunch(input: {
  store: SystemPromptStore;
  workspaceId: string;
  runtimeId: string;
  resumeRuntimeSessionId?: string | undefined;
  resumeSourceSessionId?: string | undefined;
  baseSystemPrompt: string;
  roleTemplatePrompt?: string | null | undefined;
  callerPrompt?: string | undefined;
  mode?: "default" | "none" | undefined;
  runtimeArgs: string[];
  launchWarnings: string[];
  systemPromptArgv?: SystemPromptArgvMapping | undefined;
  operationInput: Pick<CreateAgentSessionOperationInput, "runtimeId" | "prompt" | "resumeRuntimeSessionId">;
  runtime: SystemPromptRuntimeArgvShape;
}): SystemPromptLaunchResolution {
  validateLaunchTextComponents([
    { component: "agentSessions.baseSystemPrompt", value: input.baseSystemPrompt },
    { component: "roleTemplate.systemPrompt", value: input.roleTemplatePrompt },
    { component: "createAgentSession.systemPrompt", value: input.callerPrompt },
    { component: "createAgentSession.prompt", value: input.operationInput.prompt },
  ]);
  const state = resolveSystemPromptState(input);
  const runtimeArgs = [...input.runtimeArgs];
  const launchWarnings = [...input.launchWarnings];
  const nativeSystemPromptArgv =
    state.value && input.systemPromptArgv ? renderSystemPromptArgv(input.systemPromptArgv, state.value) : null;
  const argvSuitability = nativeSystemPromptArgv
    ? validateSystemPromptArgv(
        projectedNativeSystemPromptArgv({
          runtimeArgs,
          nativeSystemPromptArgv,
          operationInput: input.operationInput,
          runtime: input.runtime,
        }),
      )
    : { ok: false as const, reason: "native_unavailable" as const };
  let systemPromptDelivery = state.initialDelivery;
  let systemPromptLastDelivery = state.lastDelivery;
  const shouldUseNativeSystemPrompt = Boolean(state.value && nativeSystemPromptArgv && argvSuitability.ok);
  const shouldUseFallbackSystemPrompt = Boolean(state.value && !shouldUseNativeSystemPrompt);
  if (state.value && nativeSystemPromptArgv && !argvSuitability.ok && argvSuitability.reason === "invalid") {
    throw new Error("system_prompt_argv_invalid");
  }
  if (shouldUseNativeSystemPrompt && nativeSystemPromptArgv) {
    runtimeArgs.push(...nativeSystemPromptArgv);
    systemPromptDelivery = { mode: "native_argv", runtimeId: input.runtimeId };
    systemPromptLastDelivery = systemPromptDelivery;
  } else if (shouldUseFallbackSystemPrompt) {
    const reason = nativeSystemPromptArgv ? "argv_too_large" : "native_unavailable";
    systemPromptDelivery = { mode: "pasted_wrapper", runtimeId: input.runtimeId, reason };
    systemPromptLastDelivery = systemPromptDelivery;
    launchWarnings.push(
      reason === "argv_too_large"
        ? `Runtime ${input.runtimeId} system prompt exceeded argv limits; delivered via pasted wrapper`
        : `Runtime ${input.runtimeId} has no native system prompt support; delivered via pasted wrapper`,
    );
  }
  return {
    state,
    runtimeArgs,
    launchWarnings,
    systemPromptDelivery,
    systemPromptLastDelivery,
    shouldUseFallbackSystemPrompt,
  };
}

function resolveSystemPromptState(input: {
  store: SystemPromptStore;
  workspaceId: string;
  runtimeId: string;
  resumeRuntimeSessionId?: string | undefined;
  resumeSourceSessionId?: string | undefined;
  baseSystemPrompt: string;
  roleTemplatePrompt?: string | null | undefined;
  callerPrompt?: string | undefined;
  mode?: "default" | "none" | undefined;
}): SystemPromptState {
  if (input.resumeRuntimeSessionId) {
    const lastDelivery: SystemPromptDelivery = { mode: "skipped_resume", reason: "resume" };
    if (!input.resumeSourceSessionId) {
      return {
        value: null,
        snapshot: null,
        sources: null,
        initialDelivery: null,
        lastDelivery,
      };
    }
    const source = input.store
      .listWorkspaceSessions(input.workspaceId)
      .find((session) => session.id === input.resumeSourceSessionId);
    if (
      !source ||
      source.kind !== "agent" ||
      source.workspaceId !== input.workspaceId ||
      source.runtimeId !== input.runtimeId ||
      source.runtimeSessionId !== input.resumeRuntimeSessionId
    ) {
      throw new Error("resumeSourceSessionId does not match the requested runtime session");
    }
    const snapshot = input.store.getWorkspaceSessionSystemPromptSnapshot(input.resumeSourceSessionId);
    if (snapshot) {
      assertNoRawAgentAuthorityToken(snapshot, { component: "workspaceSessions.systemPromptSnapshot" });
    }
    return {
      value: null,
      snapshot,
      sources: source.systemPromptSources ?? null,
      initialDelivery: source.systemPromptDelivery ?? null,
      lastDelivery,
    };
  }

  if (input.mode === "none") {
    const delivery: SystemPromptDelivery = { mode: "none", reason: "empty" };
    return { value: null, snapshot: null, sources: [], initialDelivery: delivery, lastDelivery: delivery };
  }

  const parts: Array<{ source: SystemPromptSource; value: string }> = [];
  const basePrompt = normalizeSystemPromptPart(input.baseSystemPrompt);
  if (basePrompt) parts.push({ source: "settings_base", value: basePrompt });
  const rolePrompt = normalizeSystemPromptPart(input.roleTemplatePrompt ?? "");
  if (rolePrompt) parts.push({ source: "role_template", value: rolePrompt });
  const callerPrompt = normalizeSystemPromptPart(input.callerPrompt ?? "");
  if (callerPrompt) parts.push({ source: "caller", value: callerPrompt });

  if (parts.length === 0) {
    const delivery: SystemPromptDelivery = { mode: "none", reason: "empty" };
    return { value: null, snapshot: null, sources: [], initialDelivery: delivery, lastDelivery: delivery };
  }

  const value = parts.map((part) => part.value).join("\n\n");
  return {
    value,
    snapshot: value,
    sources: parts.map((part) => part.source),
    initialDelivery: { mode: "none", reason: "empty" },
    lastDelivery: { mode: "none", reason: "empty" },
  };
}

function normalizeSystemPromptPart(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function validateSystemPromptArgv(argv: string[]): { ok: true } | { ok: false; reason: "invalid" | "too_large" } {
  let totalBytes = 0;
  for (const arg of argv) {
    if (hasUnsupportedArgvControl(arg)) return { ok: false, reason: "invalid" };
    const bytes = Buffer.byteLength(arg, "utf8");
    totalBytes += bytes + 1;
    if (bytes > MAX_SYSTEM_PROMPT_ARGV_SEGMENT_BYTES || totalBytes > MAX_AGENT_PROCESS_ARGV_BYTES) {
      return { ok: false, reason: "too_large" };
    }
  }
  return { ok: true };
}

function hasUnsupportedArgvControl(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code === 0) return true;
    if (code < 32 && char !== "\n" && char !== "\r" && char !== "\t") return true;
  }
  return false;
}

function projectedNativeSystemPromptArgv(input: {
  runtimeArgs: string[];
  nativeSystemPromptArgv: string[];
  operationInput: Pick<CreateAgentSessionOperationInput, "runtimeId" | "prompt" | "resumeRuntimeSessionId">;
  runtime: SystemPromptRuntimeArgvShape;
}): string[] {
  const projected = [...input.runtimeArgs, ...input.nativeSystemPromptArgv];
  if (input.operationInput.resumeRuntimeSessionId && input.runtime.resumeArg) {
    projected.push(input.runtime.resumeArg, input.operationInput.resumeRuntimeSessionId);
  } else if (input.runtime.sessionIdArg) {
    projected.push(input.runtime.sessionIdArg, "00000000-0000-4000-8000-000000000000");
  }
  if (input.operationInput.prompt?.length) {
    if (input.runtime.promptArg) projected.push(input.runtime.promptArg, input.operationInput.prompt);
    else if (input.operationInput.runtimeId === "codex") projected.push(input.operationInput.prompt);
  }
  return projected;
}

export function validateLaunchTextComponents(
  components: Array<{ component: string; value?: string | null | undefined }>,
): void {
  for (const component of components) {
    if (!component.value) continue;
    assertNoRawAgentAuthorityToken(component.value, { component: component.component });
  }
}

export function renderSystemPromptFallbackMessage(systemPrompt: string, userPrompt: string | null): string {
  return `<citadel-system-instructions>
${systemPrompt}
</citadel-system-instructions>

<user-task>
${userPrompt?.trim() || "No initial task was provided. Wait for the next user instruction."}
</user-task>`;
}
