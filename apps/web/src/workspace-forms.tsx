import type { AgentRuntime, Repo, Workspace } from "@citadel/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Play } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, queryClient } from "./api.js";
import { Button } from "./components/ui/button.js";

type WorkspaceSource = "scratch" | "issue" | "imported" | "pr";

export function WorkspaceForm(props: { repo: Repo; runtimes?: AgentRuntime[] }) {
  const [name, setName] = useState("");
  const [source, setSource] = useState<WorkspaceSource>("scratch");
  const [issueKey, setIssueKey] = useState("");
  const [issueTitle, setIssueTitle] = useState("");
  const [prUrl, setPrUrl] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [existingBranch, setExistingBranch] = useState("");
  const [task, setTask] = useState("");
  const runtimes = props.runtimes ?? [];
  const healthyRuntimes = runtimes.filter((runtime) => runtime.health === "healthy");
  const [runtimeId, setRuntimeId] = useState<string>(healthyRuntimes[0]?.id ?? "");
  useEffect(() => {
    if (!runtimeId && healthyRuntimes[0]) {
      setRuntimeId(healthyRuntimes[0].id);
    }
  }, [healthyRuntimes, runtimeId]);
  const branches = useQuery({
    queryKey: ["repo-branches", props.repo.id],
    queryFn: () =>
      api<{ defaultBranch: string; local: string[]; remote: string[]; error?: string }>(
        `/api/repos/${props.repo.id}/branches`,
      ),
    staleTime: 30_000,
  });
  const mutation = useMutation({
    mutationFn: async () => {
      const created = await api<{ workspaceId: string }>("/api/workspaces", {
        method: "POST",
        body: JSON.stringify({
          repoId: props.repo.id,
          name: name || (source === "imported" ? existingBranch : name),
          source,
          issueKey: issueKey || undefined,
          issueTitle: issueTitle || undefined,
          prUrl: prUrl || undefined,
          baseBranch: baseBranch || undefined,
          existingBranch: source === "imported" && existingBranch ? existingBranch : undefined,
        }),
      });
      if (task.trim() && runtimeId) {
        await api("/api/agent-sessions", {
          method: "POST",
          body: JSON.stringify({
            workspaceId: created.workspaceId,
            runtimeId,
            prompt: task.trim(),
          }),
        });
      }
      return created;
    },
    onSuccess: () => {
      setName("");
      setIssueKey("");
      setIssueTitle("");
      setPrUrl("");
      setExistingBranch("");
      setTask("");
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
  });
  const previewBranch = source === "imported" && existingBranch ? existingBranch : name || "(branch from name)";
  const previewBase = baseBranch || branches.data?.defaultBranch || props.repo.defaultBranch;
  return (
    <form
      className="stack-form"
      onSubmit={(event) => {
        event.preventDefault();
        mutation.mutate();
      }}
    >
      <label>
        Workspace
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="short-task-name" />
      </label>
      <label>
        Source
        <select value={source} onChange={(event) => setSource(event.target.value as WorkspaceSource)}>
          <option value="scratch">Scratch (new branch)</option>
          <option value="imported">From existing branch</option>
          <option value="issue">From issue</option>
          <option value="pr">From pull request</option>
        </select>
      </label>
      {source !== "imported" ? (
        <label>
          Base branch
          <select value={baseBranch} onChange={(event) => setBaseBranch(event.target.value)}>
            <option value="">{branches.data?.defaultBranch || props.repo.defaultBranch}</option>
            {(branches.data?.remote ?? []).map((branch) => (
              <option key={`rb-${branch}`} value={branch}>
                {branch}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {source === "imported" ? (
        <label>
          Existing branch
          <select value={existingBranch} onChange={(event) => setExistingBranch(event.target.value)}>
            <option value="">Select a branch</option>
            {(branches.data?.local ?? []).map((branch) => (
              <option key={`lb-${branch}`} value={branch}>
                {branch} (local)
              </option>
            ))}
            {(branches.data?.remote ?? []).map((branch) => (
              <option key={`rb2-${branch}`} value={branch}>
                {branch} (remote)
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {source === "issue" ? (
        <>
          <label>
            Issue key
            <input value={issueKey} onChange={(event) => setIssueKey(event.target.value)} placeholder="MS-123" />
          </label>
          <label>
            Issue title
            <input
              value={issueTitle}
              onChange={(event) => setIssueTitle(event.target.value)}
              placeholder="Optional title"
            />
          </label>
        </>
      ) : null}
      {source === "pr" ? (
        <label>
          PR URL
          <input
            value={prUrl}
            onChange={(event) => setPrUrl(event.target.value)}
            placeholder="https://github.com/org/repo/pull/123"
          />
        </label>
      ) : null}
      <div className="workspace-preview">
        <small>
          branch: <code>{previewBranch}</code>
        </small>
        <small>
          base: <code>{previewBase}</code>
        </small>
      </div>
      {healthyRuntimes.length ? (
        <>
          <label>
            Agent task (optional)
            <textarea
              value={task}
              onChange={(event) => setTask(event.target.value)}
              placeholder="Describe what the agent should do. Leave empty to skip auto-launch."
              rows={2}
            />
          </label>
          {task.trim() ? (
            <label>
              Launch with
              <select value={runtimeId} onChange={(event) => setRuntimeId(event.target.value)}>
                {healthyRuntimes.map((runtime) => (
                  <option key={runtime.id} value={runtime.id}>
                    {runtime.displayName}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </>
      ) : null}
      <Button
        type="submit"
        disabled={
          mutation.isPending ||
          (source === "imported" ? !existingBranch : !name) ||
          (source === "issue" && !issueKey) ||
          (source === "pr" && !prUrl)
        }
      >
        {task.trim() ? "Create workspace and launch agent" : "Create workspace"}
      </Button>
      {mutation.error ? <p>{String(mutation.error)}</p> : null}
    </form>
  );
}

export function RuntimeLauncher(props: { workspace: Workspace; runtimes: AgentRuntime[] }) {
  const [runtimeId, setRuntimeId] = useState(props.runtimes[0]?.id ?? "");
  const [prompt, setPrompt] = useState("");
  const startSession = useMutation({
    mutationFn: (input: { runtimeId: string; prompt?: string; displayName?: string }) =>
      api("/api/agent-sessions", {
        method: "POST",
        body: JSON.stringify({
          workspaceId: props.workspace.id,
          runtimeId: input.runtimeId,
          ...(input.prompt ? { prompt: input.prompt } : {}),
          ...(input.displayName ? { displayName: input.displayName } : {}),
        }),
      }),
    onSuccess: () => {
      setPrompt("");
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
  });
  const startTerminal = useMutation({
    mutationFn: () =>
      api(`/api/workspaces/${encodeURIComponent(props.workspace.id)}/terminal-sessions`, { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
  });
  const runtime = useMemo(
    () => props.runtimes.find((candidate) => candidate.id === runtimeId),
    [props.runtimes, runtimeId],
  );
  return (
    <div className="runtime-launcher">
      <select value={runtimeId} onChange={(event) => setRuntimeId(event.target.value)}>
        {props.runtimes.length === 0 ? <option value="">No agent runtimes</option> : null}
        {props.runtimes.map((candidate) => (
          <option key={candidate.id} value={candidate.id}>
            {candidate.displayName} - {candidate.health}
          </option>
        ))}
      </select>
      {runtime ? (
        <textarea
          className="runtime-prompt"
          placeholder="Initial task for the agent (optional)"
          rows={2}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
        />
      ) : null}
      <div className="runtime-launcher-actions">
        <Button
          type="button"
          disabled={!runtime || runtime.health !== "healthy" || startSession.isPending}
          onClick={() => startSession.mutate(prompt.trim() ? { runtimeId, prompt: prompt.trim() } : { runtimeId })}
        >
          <Play size={15} /> Start agent
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={startTerminal.isPending}
          onClick={() => startTerminal.mutate()}
          title="Open a plain workspace terminal without launching an agent"
        >
          Open terminal
        </Button>
      </div>
      {runtime?.healthReason ? <p>{runtime.healthReason}</p> : null}
    </div>
  );
}
