import type { ProviderHealth } from "@citadel/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Save } from "lucide-react";
import { useEffect, useState } from "react";
import { api, queryClient } from "./api.js";
import { Button } from "./components/ui/button.js";
import { formatLabel } from "./labels.js";

type ProviderConfigShape = {
  github: { enabled: boolean; command?: string };
  jira: { enabled: boolean; command?: string; projectKey?: string };
};

type ConfigResponse = { config: { providers: ProviderConfigShape } };

type Method = {
  id: string;
  label: string;
  command: string;
  supported: boolean;
  description: string;
};

type CategorySpec = {
  id: "tickets" | "git-server";
  label: string;
  blurb: string;
  providers: ProviderSpec[];
};

type ProviderSpec = {
  id: "jira" | "github";
  label: string;
  blurb: string;
  healthIds: string[];
  methods: Method[];
  status: "supported" | "planned";
};

const CATEGORIES: CategorySpec[] = [
  {
    id: "tickets",
    label: "Tickets",
    blurb: "Issue trackers Citadel can read, link, and transition. Choose one provider per category.",
    providers: [
      {
        id: "jira",
        label: "Jira",
        blurb: "Atlassian Jira Cloud or Server. Configure the interaction method below.",
        healthIds: ["jira-jtk"],
        status: "supported",
        methods: [
          {
            id: "jtk",
            label: "jtk CLI",
            command: "jtk",
            supported: true,
            description: "Shell-backed Jira toolkit. Citadel relies on existing jtk auth.",
          },
          {
            id: "acli",
            label: "acli CLI",
            command: "acli",
            supported: false,
            description: "Atlassian acli — planned. Not yet wired into Citadel.",
          },
          {
            id: "api",
            label: "Direct API (token)",
            command: "https",
            supported: false,
            description: "REST + API token — planned. Will require key management in settings.",
          },
        ],
      },
    ],
  },
  {
    id: "git-server",
    label: "Git server / PR / CI",
    blurb: "Where pull requests live and where CI runs. Choose one provider per category.",
    providers: [
      {
        id: "github",
        label: "GitHub",
        blurb: "GitHub.com and GitHub Enterprise via the gh CLI.",
        healthIds: ["github-gh"],
        status: "supported",
        methods: [
          {
            id: "gh",
            label: "gh CLI",
            command: "gh",
            supported: true,
            description: "GitHub CLI. Citadel relies on existing gh auth (gh auth status).",
          },
          {
            id: "api",
            label: "Direct API (token)",
            command: "https",
            supported: false,
            description: "REST + token — planned. Will require key management in settings.",
          },
        ],
      },
    ],
  },
];

export function ProvidersPanel(props: { providerHealth: ProviderHealth[] }) {
  const configQuery = useQuery({
    queryKey: ["config"],
    queryFn: () => api<ConfigResponse>("/api/config"),
  });

  const [githubEnabled, setGithubEnabled] = useState(true);
  const [githubCommand, setGithubCommand] = useState("gh");
  const [jiraEnabled, setJiraEnabled] = useState(true);
  const [jiraCommand, setJiraCommand] = useState("jtk");
  const [jiraProject, setJiraProject] = useState("");

  useEffect(() => {
    const providers = configQuery.data?.config.providers;
    if (!providers) return;
    setGithubEnabled(providers.github.enabled);
    setGithubCommand(providers.github.command ?? "gh");
    setJiraEnabled(providers.jira.enabled);
    setJiraCommand(providers.jira.command ?? "jtk");
    setJiraProject(providers.jira.projectKey ?? "");
  }, [configQuery.data]);

  const save = useMutation({
    mutationFn: () =>
      api("/api/config", {
        method: "PUT",
        body: JSON.stringify({
          providers: {
            github: { enabled: githubEnabled, command: githubCommand || undefined },
            jira: {
              enabled: jiraEnabled,
              command: jiraCommand || undefined,
              projectKey: jiraProject || undefined,
            },
          },
        }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["config"] });
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
  });

  if (configQuery.isLoading) return <div className="empty">Loading providers…</div>;

  const healthByProvider = new Map(props.providerHealth.map((entry) => [entry.id, entry]));

  return (
    <form
      className="settings-stack"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <p className="settings-hint">
        Pick one provider per category, then choose how Citadel talks to it. Only methods marked Supported are
        implemented today. Health is checked via the provider's own auth.
      </p>
      {CATEGORIES.map((category) => (
        <section key={category.id} className="settings-card">
          <header className="settings-card-header">
            <h3>{category.label}</h3>
            <p>{category.blurb}</p>
          </header>
          <div className="provider-grid">
            {category.providers.map((provider) => {
              const enabled = provider.id === "github" ? githubEnabled : jiraEnabled;
              const command = provider.id === "github" ? githubCommand : jiraCommand;
              const setEnabled = provider.id === "github" ? setGithubEnabled : setJiraEnabled;
              const setCommand = provider.id === "github" ? setGithubCommand : setJiraCommand;
              const health = provider.healthIds
                .map((id) => healthByProvider.get(id))
                .filter(Boolean) as ProviderHealth[];
              const extras: Partial<ProviderRowProps> =
                provider.id === "jira" ? { jiraProject, onJiraProject: setJiraProject } : {};
              return (
                <ProviderRow
                  key={provider.id}
                  provider={provider}
                  enabled={enabled}
                  command={command}
                  onEnabled={setEnabled}
                  onCommand={setCommand}
                  health={health}
                  {...extras}
                />
              );
            })}
          </div>
        </section>
      ))}
      <div className="settings-actions">
        <Button type="submit" disabled={save.isPending}>
          <Save size={14} /> Save providers
        </Button>
        {save.error ? <p className="form-error">{String(save.error)}</p> : null}
      </div>
    </form>
  );
}

type ProviderRowProps = {
  provider: ProviderSpec;
  enabled: boolean;
  command: string;
  onEnabled: (value: boolean) => void;
  onCommand: (value: string) => void;
  health: ProviderHealth[];
  jiraProject?: string;
  onJiraProject?: (value: string) => void;
};

function ProviderRow(props: ProviderRowProps) {
  const activeMethod =
    props.provider.methods.find((method) => method.command === props.command) ?? props.provider.methods[0];
  return (
    <article className="provider-card">
      <header className="provider-card-header">
        <label className="provider-card-title">
          <input
            type="checkbox"
            checked={props.enabled}
            onChange={(event) => props.onEnabled(event.target.checked)}
            aria-label={`Enable ${props.provider.label}`}
          />
          <strong>{props.provider.label}</strong>
          <span className={`provider-status-pill ${props.provider.status}`}>
            {props.provider.status === "supported" ? "Supported" : "Planned"}
          </span>
        </label>
        <p>{props.provider.blurb}</p>
      </header>
      <fieldset className="provider-methods" disabled={!props.enabled}>
        <legend>Interaction method</legend>
        {props.provider.methods.map((method) => (
          <label
            key={method.id}
            className={`provider-method ${activeMethod?.id === method.id ? "active" : ""} ${method.supported ? "" : "disabled"}`}
            title={method.supported ? method.description : `${method.description} (not yet supported)`}
          >
            <input
              type="radio"
              name={`${props.provider.id}-method`}
              value={method.command}
              checked={activeMethod?.id === method.id}
              disabled={!method.supported}
              onChange={() => props.onCommand(method.command)}
            />
            <span>
              <strong>{method.label}</strong>
              <small>{method.description}</small>
            </span>
          </label>
        ))}
      </fieldset>
      {activeMethod?.supported ? (
        <div className="provider-method-config">
          <label>
            Command
            <input value={props.command} onChange={(event) => props.onCommand(event.target.value)} />
          </label>
          {props.provider.id === "jira" ? (
            <label>
              Jira project key (optional)
              <input
                value={props.jiraProject ?? ""}
                onChange={(event) => props.onJiraProject?.(event.target.value)}
                placeholder="ABC"
              />
            </label>
          ) : null}
        </div>
      ) : (
        <div className="provider-method-config">
          <small className="provider-method-pending">
            This method is not yet implemented. Citadel will surface this configuration here when it lands.
          </small>
        </div>
      )}
      <div className="provider-health-list">
        {props.health.length ? (
          props.health.map((entry) => (
            <div key={entry.id} className={`provider-health ${entry.status}`}>
              <strong>{entry.displayName}</strong>
              <span>{formatLabel(entry.status)}</span>
              {entry.reason ? <small>{entry.reason}</small> : null}
            </div>
          ))
        ) : (
          <div className="provider-health unavailable">
            <strong>No health probe</strong>
            <span>Save providers to refresh checks</span>
          </div>
        )}
      </div>
    </article>
  );
}
