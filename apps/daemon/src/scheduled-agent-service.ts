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
    const result = this.runner.delete(id);
    if (!result.ok) return { ok: false, error: result.error };
    this.emit("scheduled-agent.updated", { id, removed: true });
    return { ok: true, value: true };
  }

  /**
   * Manual "Run now" — surfaces all four outcomes (ran / queued / skipped /
   * queue_full) plus the not-found case. HTTP routes and MCP handlers map
   * the discriminated union into their respective envelope shapes.
   */
  async runNow(id: string): Promise<
    | {
        ok: true;
        value: {
          kind: "ran";
          runId: string;
          status: "succeeded" | "failed";
          message: string;
          workspaceId: string | null;
          sessionId: string | null;
          backgroundSessionId: string | null;
          scheduledAgent: ScheduledAgent | null;
        };
      }
    | {
        ok: true;
        value: { kind: "queued"; runId: string; queuePosition: number; scheduledAgent: ScheduledAgent | null };
      }
    | { ok: true; value: { kind: "skipped_overlap"; scheduledAgent: ScheduledAgent | null } }
    | { ok: true; value: { kind: "queue_full"; limit: number; scheduledAgent: ScheduledAgent | null } }
    | { ok: false; error: "scheduled_agent_not_found" }
  > {
    const agent = this.runner.find(id);
    if (!agent) return { ok: false, error: "scheduled_agent_not_found" };
    const result = await this.runner.runNow(id);
    if (result.kind === "ran") {
      // scheduled-agent.run-row events are emitted by the runner itself
      // (enqueue/promote/outcome). Emitting again here would cause the
      // History drawer to refetch twice per transition. Only the legacy
      // scheduled-agent.run event (used by the cockpit list) is service-owned.
      this.emit("scheduled-agent.run", { id, status: result.status });
      return {
        ok: true,
        value: {
          kind: "ran",
          runId: result.runId,
          status: result.status,
          message: result.message,
          workspaceId: result.workspaceId,
          sessionId: result.sessionId,
          backgroundSessionId: result.backgroundSessionId,
          scheduledAgent: this.runner.find(id),
        },
      };
    }
    if (result.kind === "queued") {
      // Same rationale as 'ran' above — the runner already emitted run-row
      // for the new 'queued' status from inside enqueueRunRow.
      return {
        ok: true,
        value: {
          kind: "queued",
          runId: result.runId,
          queuePosition: result.queuePosition,
          scheduledAgent: this.runner.find(id),
        },
      };
    }
    if (result.kind === "skipped_overlap") {
      return { ok: true, value: { kind: "skipped_overlap", scheduledAgent: this.runner.find(id) } };
    }
    return { ok: true, value: { kind: "queue_full", limit: result.limit, scheduledAgent: this.runner.find(id) } };
  }
}
