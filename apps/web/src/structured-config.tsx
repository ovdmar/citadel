import { useMutation, useQuery } from "@tanstack/react-query";
import { Plus, Save, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api, queryClient } from "./api.js";
import { Button } from "./components/ui/button.js";

type RuntimeConfig = {
  id: string;
  displayName: string;
  command: string;
  args: string[];
  promptArg?: string | undefined;
  resumeArg?: string | undefined;
  supportsResume?: boolean | undefined;
  supportsPrompt?: boolean | undefined;
  supportsModelSelection?: boolean | undefined;
};

type TerminalProfileConfig = {
  displayName: string;
  command: string;
  args: string[];
};

type HookConfig = {
  id: string;
  kind: "command";
  event:
    | "workspace.setup"
    | "workspace.teardown"
    | "workspace.apps"
    | "workspace.action"
    | "workspace.created"
    | "workspace.archived"
    | "workspace.removed"
    | "agent.started";
  command: string;
  args: string[];
  cwd?: string | undefined;
  blocking?: boolean | undefined;
};

type UsageProviderConfig = {
  id: string;
  runtimeId: string;
  command: string;
  args: string[];
  cwd?: string | undefined;
};

type ConfigResponse = {
  config: {
    mcp: { enabled: boolean };
    providers: {
      github: { enabled: boolean; command?: string };
      jira: { enabled: boolean; command?: string; projectKey?: string };
    };
    agentRuntimes: RuntimeConfig[];
    terminal: TerminalProfileConfig;
    usageProviders: UsageProviderConfig[];
    hooks: HookConfig[];
    repoDefaults: { setupHookIds: string[]; teardownHookIds: string[] };
    commandPolicy: { hookTimeoutMs: number; allowDestructiveWorkspaceCleanup: boolean };
    scratchpad?: { path?: string };
  };
  configPath: string;
};

const HOOK_EVENTS: HookConfig["event"][] = [
  "workspace.setup",
  "workspace.teardown",
  "workspace.apps",
  "workspace.action",
  "workspace.created",
  "workspace.archived",
  "workspace.removed",
  "agent.started",
];

export function StructuredConfig() {
  const configQuery = useQuery({
    queryKey: ["config"],
    queryFn: () => api<ConfigResponse>("/api/config"),
  });
  const [runtimes, setRuntimes] = useState<RuntimeConfig[]>([]);
  const [terminal, setTerminal] = useState<TerminalProfileConfig>({
    displayName: "Terminal",
    command: "bash",
    args: ["-l"],
  });
  const [hooks, setHooks] = useState<HookConfig[]>([]);
  const [usageProviders, setUsageProviders] = useState<UsageProviderConfig[]>([]);
  const [mcpEnabled, setMcpEnabled] = useState(true);
  const [githubEnabled, setGithubEnabled] = useState(true);
  const [githubCommand, setGithubCommand] = useState("gh");
  const [jiraEnabled, setJiraEnabled] = useState(true);
  const [jiraCommand, setJiraCommand] = useState("jtk");
  const [jiraProject, setJiraProject] = useState("");
  const [setupHookIds, setSetupHookIds] = useState("");
  const [teardownHookIds, setTeardownHookIds] = useState("");
  const [hookTimeoutMs, setHookTimeoutMs] = useState(120_000);
  const [allowDestructive, setAllowDestructive] = useState(false);
  const [scratchpadPath, setScratchpadPath] = useState("");

  useEffect(() => {
    const cfg = configQuery.data?.config;
    if (!cfg) return;
    setRuntimes(cfg.agentRuntimes);
    setTerminal(cfg.terminal);
    setHooks(cfg.hooks);
    setUsageProviders(cfg.usageProviders);
    setMcpEnabled(cfg.mcp.enabled);
    setGithubEnabled(cfg.providers.github.enabled);
    setGithubCommand(cfg.providers.github.command ?? "gh");
    setJiraEnabled(cfg.providers.jira.enabled);
    setJiraCommand(cfg.providers.jira.command ?? "jtk");
    setJiraProject(cfg.providers.jira.projectKey ?? "");
    setSetupHookIds(cfg.repoDefaults.setupHookIds.join(", "));
    setTeardownHookIds(cfg.repoDefaults.teardownHookIds.join(", "));
    setHookTimeoutMs(cfg.commandPolicy.hookTimeoutMs);
    setAllowDestructive(cfg.commandPolicy.allowDestructiveWorkspaceCleanup);
    setScratchpadPath(cfg.scratchpad?.path ?? "");
  }, [configQuery.data]);

  const save = useMutation({
    mutationFn: () =>
      api<ConfigResponse>("/api/config", {
        method: "PUT",
        body: JSON.stringify({
          mcp: { enabled: mcpEnabled },
          providers: {
            github: { enabled: githubEnabled, command: githubCommand || undefined },
            jira: {
              enabled: jiraEnabled,
              command: jiraCommand || undefined,
              projectKey: jiraProject || undefined,
            },
          },
          agentRuntimes: runtimes,
          terminal,
          usageProviders,
          hooks,
          repoDefaults: {
            setupHookIds: split(setupHookIds),
            teardownHookIds: split(teardownHookIds),
          },
          commandPolicy: { hookTimeoutMs, allowDestructiveWorkspaceCleanup: allowDestructive },
          scratchpad: { path: scratchpadPath.trim() || undefined },
        }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["config"] });
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
  });

  if (configQuery.isLoading) return <div className="empty">Loading config…</div>;
  return (
    <form
      className="config-form"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <div className="config-path">{configQuery.data?.configPath}</div>

      <section className="config-section">
        <h3>Toggles</h3>
        <div className="toggle-grid">
          <label>
            <input type="checkbox" checked={mcpEnabled} onChange={(event) => setMcpEnabled(event.target.checked)} /> MCP
          </label>
          <label>
            <input
              type="checkbox"
              checked={githubEnabled}
              onChange={(event) => setGithubEnabled(event.target.checked)}
            />{" "}
            GitHub
          </label>
          <label>
            <input type="checkbox" checked={jiraEnabled} onChange={(event) => setJiraEnabled(event.target.checked)} />{" "}
            Jira
          </label>
          <label>
            <input
              type="checkbox"
              checked={allowDestructive}
              onChange={(event) => setAllowDestructive(event.target.checked)}
            />{" "}
            Force cleanup allowed
          </label>
        </div>
      </section>

      <section className="config-section">
        <h3>Providers</h3>
        <div className="form-grid">
          <label>
            GitHub command
            <input value={githubCommand} onChange={(event) => setGithubCommand(event.target.value)} />
          </label>
          <label>
            Jira command
            <input value={jiraCommand} onChange={(event) => setJiraCommand(event.target.value)} />
          </label>
          <label>
            Jira project key (optional)
            <input value={jiraProject} onChange={(event) => setJiraProject(event.target.value)} placeholder="MS" />
          </label>
          <label>
            Hook timeout (ms)
            <input
              type="number"
              min={1000}
              step={1000}
              value={hookTimeoutMs}
              onChange={(event) => setHookTimeoutMs(Number(event.target.value))}
            />
          </label>
        </div>
      </section>

      <section className="config-section">
        <h3>Notes</h3>
        <div className="form-grid">
          <label>
            Notes location
            <input
              data-testid="notes-location-input"
              value={scratchpadPath}
              onChange={(event) => setScratchpadPath(event.target.value)}
              placeholder="Default: <dataDir>/scratchpad.md"
            />
            <small>
              Absolute path. Leave empty to use the default under the data directory. <code>~/</code> is expanded to
              your home directory.
            </small>
          </label>
        </div>
      </section>

      <section className="config-section">
        <h3>Terminal</h3>
        <div className="structured-row">
          <input
            placeholder="Display name"
            value={terminal.displayName}
            onChange={(event) => setTerminal({ ...terminal, displayName: event.target.value })}
          />
          <input
            placeholder="command"
            value={terminal.command}
            onChange={(event) => setTerminal({ ...terminal, command: event.target.value })}
          />
          <input
            placeholder="args (space-separated)"
            value={terminal.args.join(" ")}
            onChange={(event) => setTerminal({ ...terminal, args: event.target.value.split(/\s+/).filter(Boolean) })}
          />
        </div>
      </section>

      <section className="config-section">
        <h3>Agent runtimes</h3>
        {runtimes.map((runtime, index) => (
          <div key={`runtime-${index}-${runtime.id}`} className="structured-row">
            <input
              placeholder="id"
              value={runtime.id}
              onChange={(event) => setRuntimes(updateAt(runtimes, index, { id: event.target.value }))}
            />
            <input
              placeholder="Display name"
              value={runtime.displayName}
              onChange={(event) => setRuntimes(updateAt(runtimes, index, { displayName: event.target.value }))}
            />
            <input
              placeholder="command"
              value={runtime.command}
              onChange={(event) => setRuntimes(updateAt(runtimes, index, { command: event.target.value }))}
            />
            <input
              placeholder="args (space-separated)"
              value={runtime.args.join(" ")}
              onChange={(event) =>
                setRuntimes(updateAt(runtimes, index, { args: event.target.value.split(/\s+/).filter(Boolean) }))
              }
            />
            <input
              placeholder="promptArg"
              value={runtime.promptArg ?? ""}
              onChange={(event) =>
                setRuntimes(updateAt(runtimes, index, { promptArg: event.target.value || undefined }))
              }
            />
            <input
              placeholder="resumeArg"
              value={runtime.resumeArg ?? ""}
              onChange={(event) =>
                setRuntimes(updateAt(runtimes, index, { resumeArg: event.target.value || undefined }))
              }
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`Remove runtime ${runtime.id}`}
              onClick={() => setRuntimes(runtimes.filter((_, i) => i !== index))}
            >
              <Trash2 size={14} />
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="secondary"
          onClick={() =>
            setRuntimes([...runtimes, { id: "new-runtime", displayName: "New", command: "bash", args: ["-l"] }])
          }
        >
          <Plus size={14} /> Add runtime
        </Button>
      </section>

      <section className="config-section">
        <h3>Hooks</h3>
        {hooks.map((hook, index) => (
          <div key={`hook-${index}-${hook.id}`} className="structured-row">
            <input
              placeholder="id"
              value={hook.id}
              onChange={(event) => setHooks(updateAt(hooks, index, { id: event.target.value }))}
            />
            <select
              value={hook.event}
              onChange={(event) =>
                setHooks(updateAt(hooks, index, { event: event.target.value as HookConfig["event"] }))
              }
            >
              {HOOK_EVENTS.map((event) => (
                <option key={event} value={event}>
                  {event}
                </option>
              ))}
            </select>
            <input
              placeholder="command"
              value={hook.command}
              onChange={(event) => setHooks(updateAt(hooks, index, { command: event.target.value }))}
            />
            <input
              placeholder="args"
              value={hook.args.join(" ")}
              onChange={(event) =>
                setHooks(updateAt(hooks, index, { args: event.target.value.split(/\s+/).filter(Boolean) }))
              }
            />
            <input
              placeholder="cwd (absolute)"
              value={hook.cwd ?? ""}
              onChange={(event) => setHooks(updateAt(hooks, index, { cwd: event.target.value || undefined }))}
            />
            <label className="hook-blocking">
              <input
                type="checkbox"
                checked={!!hook.blocking}
                onChange={(event) => setHooks(updateAt(hooks, index, { blocking: event.target.checked }))}
              />
              blocking
            </label>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`Remove hook ${hook.id}`}
              onClick={() => setHooks(hooks.filter((_, i) => i !== index))}
            >
              <Trash2 size={14} />
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="secondary"
          onClick={() =>
            setHooks([
              ...hooks,
              {
                id: `hook-${hooks.length + 1}`,
                kind: "command",
                event: "workspace.setup",
                command: "echo",
                args: ["hello"],
              },
            ])
          }
        >
          <Plus size={14} /> Add hook
        </Button>
        <div className="form-grid">
          <label>
            Setup hook IDs
            <input value={setupHookIds} onChange={(event) => setSetupHookIds(event.target.value)} />
          </label>
          <label>
            Teardown hook IDs
            <input value={teardownHookIds} onChange={(event) => setTeardownHookIds(event.target.value)} />
          </label>
        </div>
      </section>

      <section className="config-section">
        <h3>Usage providers</h3>
        {usageProviders.map((usage, index) => (
          <div key={`usage-${index}-${usage.id}`} className="structured-row">
            <input
              placeholder="id"
              value={usage.id}
              onChange={(event) => setUsageProviders(updateAt(usageProviders, index, { id: event.target.value }))}
            />
            <input
              placeholder="runtimeId"
              value={usage.runtimeId}
              onChange={(event) =>
                setUsageProviders(updateAt(usageProviders, index, { runtimeId: event.target.value }))
              }
            />
            <input
              placeholder="command"
              value={usage.command}
              onChange={(event) => setUsageProviders(updateAt(usageProviders, index, { command: event.target.value }))}
            />
            <input
              placeholder="args"
              value={usage.args.join(" ")}
              onChange={(event) =>
                setUsageProviders(
                  updateAt(usageProviders, index, { args: event.target.value.split(/\s+/).filter(Boolean) }),
                )
              }
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`Remove usage provider ${usage.id}`}
              onClick={() => setUsageProviders(usageProviders.filter((_, i) => i !== index))}
            >
              <Trash2 size={14} />
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="secondary"
          onClick={() =>
            setUsageProviders([
              ...usageProviders,
              { id: `usage-${usageProviders.length + 1}`, runtimeId: "claude-code", command: "echo", args: ["{}"] },
            ])
          }
        >
          <Plus size={14} /> Add usage provider
        </Button>
      </section>

      <Button type="submit" disabled={save.isPending}>
        <Save size={14} /> Save config
      </Button>
      {save.error ? <p className="form-error">{String(save.error)}</p> : null}
    </form>
  );
}

function updateAt<T>(items: T[], index: number, patch: Partial<T>): T[] {
  return items.map((item, i) => (i === index ? { ...item, ...patch } : item));
}

function split(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}
