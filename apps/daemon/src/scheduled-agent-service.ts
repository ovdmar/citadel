import type { CreateScheduledAgentInput, ScheduledAgent, UpdateScheduledAgentInput } from "@citadel/contracts";
import type { ScheduledAgentRunner } from "@citadel/operations";

/**
 * Owns the parse + runner-call + emit choreography for scheduled-agent
 * mutations so the HTTP and MCP entry points stay in sync. Each method
 * returns a discriminated result; callers do their own status-code or
 * MCP-shape mapping.
 */
export type ScheduledAgentMutationResult<T> = { ok: true; value: T } | { ok: false; error: string };

export class ScheduledAgentService {
  constructor(
    private readonly runner: ScheduledAgentRunner,
    private readonly emit: (type: string, payload: unknown) => void,
  ) {}

  create(input: CreateScheduledAgentInput): ScheduledAgentMutationResult<ScheduledAgent> {
    try {
      const agent = this.runner.create(input);
      this.emit("scheduled-agent.updated", { id: agent.id, agent });
      return { ok: true, value: agent };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "scheduled_agent_create_failed" };
    }
  }

  update(id: string, input: UpdateScheduledAgentInput): ScheduledAgentMutationResult<ScheduledAgent | null> {
    try {
      const agent = this.runner.update(id, input);
      if (!agent) return { ok: false, error: "scheduled_agent_not_found" };
      this.emit("scheduled-agent.updated", { id: agent.id, agent });
      return { ok: true, value: agent };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "scheduled_agent_update_failed" };
    }
  }

  delete(id: string): ScheduledAgentMutationResult<true> {
    const removed = this.runner.delete(id);
    if (!removed) return { ok: false, error: "scheduled_agent_not_found" };
    this.emit("scheduled-agent.updated", { id, removed: true });
    return { ok: true, value: true };
  }

  async runNow(id: string) {
    const agent = this.runner.find(id);
    if (!agent) return { ok: false as const, error: "scheduled_agent_not_found" };
    const result = await this.runner.runOnce(id);
    this.emit("scheduled-agent.run", { id, status: result.status });
    return {
      ok: true as const,
      value: {
        status: result.status,
        message: result.message,
        workspaceId: result.workspaceId,
        sessionId: result.sessionId,
        scheduledAgent: this.runner.find(id),
      },
    };
  }
}
