import { useMutation, useQuery } from "@tanstack/react-query";
import { Save } from "lucide-react";
import { useEffect, useState } from "react";
import { ApiError, api, queryClient } from "./api.js";
import { Button } from "./components/ui/button.js";

type ConfigResponse = {
  config: {
    mcp: { enabled: boolean };
    providers: { github: { enabled: boolean }; jira: { enabled: boolean } };
    runtimes: { id: string; displayName: string; command: string; args: string[] }[];
    hooks: {
      id: string;
      kind: "command";
      event: "workspace.setup" | "workspace.teardown";
      command: string;
      args: string[];
      cwd?: string;
      blocking: boolean;
    }[];
    repoDefaults: { setupHookIds: string[]; teardownHookIds: string[] };
    commandPolicy: { hookTimeoutMs: number; allowDestructiveWorkspaceCleanup: boolean };
  };
  configPath: string;
};

export function ConfigForm() {
  const configQuery = useQuery({
    queryKey: ["config"],
    queryFn: () => api<ConfigResponse>("/api/config"),
  });
  const [mcpEnabled, setMcpEnabled] = useState(true);
  const [githubEnabled, setGithubEnabled] = useState(true);
  const [jiraEnabled, setJiraEnabled] = useState(true);
  const [hooksJson, setHooksJson] = useState("[]");
  const [runtimesJson, setRuntimesJson] = useState("[]");
  const [setupHookIds, setSetupHookIds] = useState("");
  const [teardownHookIds, setTeardownHookIds] = useState("");
  const [hookTimeoutMs, setHookTimeoutMs] = useState(120000);
  const [allowDestructiveCleanup, setAllowDestructiveCleanup] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    const config = configQuery.data?.config;
    if (!config) return;
    setMcpEnabled(config.mcp.enabled);
    setGithubEnabled(config.providers.github.enabled);
    setJiraEnabled(config.providers.jira.enabled);
    setHooksJson(JSON.stringify(config.hooks, null, 2));
    setRuntimesJson(JSON.stringify(config.runtimes, null, 2));
    setSetupHookIds(config.repoDefaults.setupHookIds.join(", "));
    setTeardownHookIds(config.repoDefaults.teardownHookIds.join(", "));
    setHookTimeoutMs(config.commandPolicy.hookTimeoutMs);
    setAllowDestructiveCleanup(config.commandPolicy.allowDestructiveWorkspaceCleanup);
  }, [configQuery.data]);

  const mutation = useMutation({
    mutationFn: () => {
      setFormError(null);
      let hooks: ConfigResponse["config"]["hooks"];
      let runtimes: ConfigResponse["config"]["runtimes"];
      try {
        hooks = JSON.parse(hooksJson) as ConfigResponse["config"]["hooks"];
        runtimes = JSON.parse(runtimesJson) as ConfigResponse["config"]["runtimes"];
      } catch (error) {
        throw new Error(error instanceof Error ? error.message : "Invalid JSON");
      }
      return api<ConfigResponse>("/api/config", {
        method: "PUT",
        body: JSON.stringify({
          mcp: { enabled: mcpEnabled },
          providers: { github: { enabled: githubEnabled }, jira: { enabled: jiraEnabled } },
          runtimes,
          hooks,
          repoDefaults: {
            setupHookIds: splitIds(setupHookIds),
            teardownHookIds: splitIds(teardownHookIds),
          },
          commandPolicy: {
            hookTimeoutMs,
            allowDestructiveWorkspaceCleanup: allowDestructiveCleanup,
          },
        }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["config"] });
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
    onError: (error) => setFormError(String(error)),
  });

  if (configQuery.isLoading) return <div className="empty">Loading config</div>;

  return (
    <form
      className="config-form"
      onSubmit={(event) => {
        event.preventDefault();
        mutation.mutate();
      }}
    >
      <div className="config-path">{configQuery.data?.configPath}</div>
      <div className="toggle-grid">
        <label>
          <input type="checkbox" checked={mcpEnabled} onChange={(event) => setMcpEnabled(event.target.checked)} />
          MCP
        </label>
        <label>
          <input type="checkbox" checked={githubEnabled} onChange={(event) => setGithubEnabled(event.target.checked)} />
          GitHub
        </label>
        <label>
          <input type="checkbox" checked={jiraEnabled} onChange={(event) => setJiraEnabled(event.target.checked)} />
          Jira
        </label>
        <label>
          <input
            type="checkbox"
            checked={allowDestructiveCleanup}
            onChange={(event) => setAllowDestructiveCleanup(event.target.checked)}
          />
          Force cleanup allowed
        </label>
      </div>
      <div className="form-grid">
        <label>
          Setup hook IDs
          <input value={setupHookIds} onChange={(event) => setSetupHookIds(event.target.value)} />
        </label>
        <label>
          Teardown hook IDs
          <input value={teardownHookIds} onChange={(event) => setTeardownHookIds(event.target.value)} />
        </label>
        <label>
          Hook timeout
          <input
            type="number"
            min={1000}
            step={1000}
            value={hookTimeoutMs}
            onChange={(event) => setHookTimeoutMs(Number(event.target.value))}
          />
        </label>
      </div>
      <div className="form-grid">
        <label>
          Hooks JSON
          <textarea value={hooksJson} onChange={(event) => setHooksJson(event.target.value)} rows={8} />
        </label>
        <label>
          Runtimes JSON
          <textarea value={runtimesJson} onChange={(event) => setRuntimesJson(event.target.value)} rows={8} />
        </label>
      </div>
      <Button type="submit" disabled={mutation.isPending}>
        <Save size={15} /> Save config
      </Button>
      <ConfigError error={formError ? new Error(formError) : mutation.error} />
    </form>
  );
}

function ConfigError(props: { error: Error | null }) {
  if (!props.error) return null;
  if (props.error instanceof ApiError && props.error.issues.length > 0) {
    return (
      <div className="form-error-list" role="alert">
        {props.error.issues.map((issue) => (
          <p key={`${issue.path}-${issue.message}`}>
            <strong>{issue.path || "config"}</strong>: {issue.message}
          </p>
        ))}
      </div>
    );
  }
  return <p className="form-error">{props.error.message}</p>;
}

function splitIds(input: string) {
  return input
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}
