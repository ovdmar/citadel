import type { ProviderHealth } from "@citadel/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, Save, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api, queryClient } from "./api.js";

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

const JIRA_METHODS: Method[] = [
  {
    id: "jtk",
    label: "jtk",
    command: "jtk",
    supported: true,
    description: "Shell-backed Jira toolkit. Citadel relies on your existing jtk auth — no token storage needed.",
  },
  {
    id: "acli",
    label: "acli",
    command: "acli",
    supported: false,
    description: "Atlassian official acli. Not yet wired into Citadel.",
  },
  {
    id: "api",
    label: "Direct API",
    command: "https",
    supported: false,
    description: "REST + API token. Requires key management in settings.",
  },
];

const GITHUB_METHODS: Method[] = [
  {
    id: "gh",
    label: "gh",
    command: "gh",
    supported: true,
    description: "GitHub CLI. Citadel reads `gh auth status` to verify the active token.",
  },
  {
    id: "api",
    label: "Direct API",
    command: "https",
    supported: false,
    description: "REST + token. Requires key management in settings.",
  },
];

export function ProvidersPanel(props: { providerHealth: ProviderHealth[] }) {
  const configQuery = useQuery({
    queryKey: ["config"],
    queryFn: () => api<ConfigResponse>("/api/config"),
  });

  const [githubCommand, setGithubCommand] = useState("gh");
  const [jiraCommand, setJiraCommand] = useState("jtk");
  const [jiraProject, setJiraProject] = useState("");
  const [pristine, setPristine] = useState<{ github: string; jira: string; project: string }>({
    github: "gh",
    jira: "jtk",
    project: "",
  });

  useEffect(() => {
    const providers = configQuery.data?.config.providers;
    if (!providers) return;
    const next = {
      github: providers.github.command ?? "gh",
      jira: providers.jira.command ?? "jtk",
      project: providers.jira.projectKey ?? "",
    };
    setGithubCommand(next.github);
    setJiraCommand(next.jira);
    setJiraProject(next.project);
    setPristine(next);
  }, [configQuery.data]);

  const save = useMutation({
    mutationFn: () =>
      api("/api/config", {
        method: "PUT",
        body: JSON.stringify({
          providers: {
            github: { enabled: true, command: githubCommand || undefined },
            jira: {
              enabled: true,
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

  if (configQuery.isLoading) {
    return <div className="set-empty">Loading providers…</div>;
  }

  const healthByProvider = new Map(props.providerHealth.map((entry) => [entry.id, entry]));
  const jiraHealth = healthByProvider.get("jira-jtk");
  const githubHealth = healthByProvider.get("github-gh");

  const dirty =
    githubCommand !== pristine.github || jiraCommand !== pristine.jira || jiraProject !== pristine.project;

  const discard = () => {
    setGithubCommand(pristine.github);
    setJiraCommand(pristine.jira);
    setJiraProject(pristine.project);
  };

  return (
    <>
      <div className="set-int-grid">
        <ProviderCard
          category="Tickets"
          name="Jira"
          brand="jira"
          methods={JIRA_METHODS}
          activeCommand={jiraCommand}
          onMethodChange={setJiraCommand}
          health={jiraHealth}
          fields={[
            { label: "Command", value: jiraCommand, onChange: setJiraCommand },
            { label: "Project", value: jiraProject, onChange: setJiraProject, width: 70 },
          ]}
        />
        <ProviderCard
          category="Git · PR · CI"
          name="GitHub"
          brand="github"
          methods={GITHUB_METHODS}
          activeCommand={githubCommand}
          onMethodChange={setGithubCommand}
          health={githubHealth}
          fields={[{ label: "Command", value: githubCommand, onChange: setGithubCommand }]}
        />
      </div>

      <div className="set-form-foot">
        <button
          type="button"
          className="set-btn set-btn-primary"
          onClick={() => save.mutate()}
          disabled={save.isPending || !dirty}
        >
          <Save size={13} /> Save integrations
        </button>
        <button
          type="button"
          className="set-btn set-btn-ghost"
          onClick={discard}
          disabled={!dirty || save.isPending}
        >
          Discard changes
        </button>
        {save.error ? <span className="form-error">{String(save.error)}</span> : null}
      </div>
    </>
  );
}

type FieldSpec = { label: string; value: string; onChange: (next: string) => void; width?: number };

function ProviderCard(props: {
  category: string;
  name: string;
  brand: "jira" | "github";
  methods: Method[];
  activeCommand: string;
  onMethodChange: (next: string) => void;
  health: ProviderHealth | undefined;
  fields: FieldSpec[];
}) {
  const Logo = props.brand === "jira" ? BrandJira : BrandGitHub;
  // Active method = whichever supported method matches the current command, or the first supported.
  const activeMethod =
    props.methods.find((method) => method.command === props.activeCommand && method.supported) ??
    props.methods.find((method) => method.supported);
  const healthy = props.health?.status === "healthy";
  const healthDetail = props.health?.reason
    ? props.health.reason
    : healthy
      ? `last verified ${formatRelativeChecked(props.health?.checkedAt)}`
      : "Health check has not run yet.";

  return (
    <div className="set-int-card">
      <div className="set-int-hero">
        <div className={`set-int-mark set-int-mark--${props.brand}`} aria-hidden>
          <Logo size={22} />
        </div>
        <div className="set-int-hero-text">
          <div className="set-int-name">{props.name}</div>
          <div className="set-int-cat">{props.category}</div>
        </div>
        <div className="set-int-hero-right">
          <span className={`set-int-status ${healthy ? "is-ok" : "is-bad"}`}>
            <span className="set-int-status-dot" />
            <span>{healthy ? "Connected" : "Disconnected"}</span>
          </span>
        </div>
      </div>

      <div className="set-int-methods">
        {props.methods.map((method) => {
          const active = activeMethod?.id === method.id;
          return (
            <button
              key={method.id}
              type="button"
              className={`set-int-method ${active ? "is-active" : ""} ${method.supported ? "" : "is-disabled"}`}
              onClick={() => method.supported && props.onMethodChange(method.command)}
              disabled={!method.supported}
              title={method.description}
            >
              <span className="set-int-method-radio">
                {active ? <span className="set-int-method-radio-fill" /> : null}
              </span>
              <span className="set-int-method-name">{method.label}</span>
              {!method.supported ? <span className="set-int-method-tag">soon</span> : null}
            </button>
          );
        })}
      </div>

      <div className="set-int-fields">
        {props.fields.map((field) => (
          <label key={field.label} className="set-int-fld">
            <span className="set-int-fld-label">{field.label}</span>
            <input
              className="set-int-fld-input"
              value={field.value}
              onChange={(event) => field.onChange(event.target.value)}
              spellCheck={false}
              style={field.width ? { width: field.width } : undefined}
            />
          </label>
        ))}
      </div>

      <div className="set-int-status-line">
        <span className={`set-int-status-icon ${healthy ? "is-ok" : "is-bad"}`} aria-hidden>
          {healthy ? <Check size={11} /> : <X size={11} />}
        </span>
        <span className="set-int-status-text">{healthDetail}</span>
      </div>
    </div>
  );
}

function formatRelativeChecked(iso: string | undefined): string {
  if (!iso) return "just now";
  const checked = new Date(iso).getTime();
  const diff = Math.max(0, Date.now() - checked);
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(iso).toLocaleString();
}

// ─── Brand glyphs ──────────────────────────────────────────────────────────
function BrandJira(props: { size?: number }) {
  const size = props.size ?? 22;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <defs>
        <linearGradient id="jira-a" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2684FF" />
          <stop offset="1" stopColor="#0052CC" />
        </linearGradient>
      </defs>
      <path
        d="M11.53 2 2 11.53a1.5 1.5 0 0 0 0 2.12L11.53 23.18a1.5 1.5 0 0 0 2.12 0L23.18 13.65a1.5 1.5 0 0 0 0-2.12L13.65 2a1.5 1.5 0 0 0-2.12 0Z"
        fill="url(#jira-a)"
      />
      <path d="M12.59 7.27 7.27 12.59l5.32 5.32 5.32-5.32-5.32-5.32Z" fill="#fff" opacity=".95" />
    </svg>
  );
}

function BrandGitHub(props: { size?: number }) {
  const size = props.size ?? 22;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <path
        d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-1.96c-3.2.7-3.87-1.54-3.87-1.54-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.74.4-1.26.73-1.55-2.55-.29-5.23-1.28-5.23-5.69 0-1.26.45-2.29 1.18-3.1-.12-.29-.51-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.78 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.18 1.84 1.18 3.1 0 4.42-2.69 5.4-5.25 5.68.41.36.78 1.07.78 2.15v3.19c0 .31.21.67.8.56C20.21 21.39 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5Z"
        fill="currentColor"
      />
    </svg>
  );
}
