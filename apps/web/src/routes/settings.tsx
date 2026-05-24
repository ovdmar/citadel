import type { AgentRuntime, ProviderHealth } from "@citadel/contracts";
import { Link } from "@tanstack/react-router";
import {
  AlarmClock,
  ArrowLeft,
  Cable,
  CheckCircle2,
  FolderGit2,
  HeartPulse,
  Server,
  Settings as SettingsIcon,
} from "lucide-react";
import { useState } from "react";
import { useStateQuery } from "../app-state.js";
import { ProvidersPanel } from "../settings-providers.js";
import { RepositoriesPanel } from "../settings-repositories.js";
import { AgentsPanel } from "../settings-runtimes.js";
import { ScheduledAgentsPanel } from "../settings-scheduled-agents.js";
import { StructuredConfig } from "../structured-config.js";
import { ThemeControls } from "../theme-controls.js";

type SectionId = "overview" | "providers" | "agents" | "scheduled-agents" | "repositories" | "mcp" | "advanced";

type Section = {
  id: SectionId;
  label: string;
  description: string;
  icon: React.ReactNode;
};

const SECTIONS: Section[] = [
  {
    id: "overview",
    label: "Overview",
    description: "Setup status and health at a glance",
    icon: <CheckCircle2 size={14} />,
  },
  { id: "providers", label: "Providers", description: "Tickets, Git server, CI", icon: <HeartPulse size={14} /> },
  { id: "agents", label: "Agents", description: "Platform and custom agents", icon: <Server size={14} /> },
  {
    id: "scheduled-agents",
    label: "Scheduled agents",
    description: "Cron-driven agent runs",
    icon: <AlarmClock size={14} />,
  },
  {
    id: "repositories",
    label: "Repositories",
    description: "Registered repos and tracking",
    icon: <FolderGit2 size={14} />,
  },
  { id: "mcp", label: "MCP", description: "Model Context Protocol toggle", icon: <Cable size={14} /> },
  {
    id: "advanced",
    label: "Advanced",
    description: "Raw config and policy",
    icon: <SettingsIcon size={14} />,
  },
];

export function SettingsView() {
  const state = useStateQuery();
  const [section, setSection] = useState<SectionId>("overview");
  const current = SECTIONS.find((entry) => entry.id === section) ?? SECTIONS[0];
  if (!current) return null;
  return (
    <div className="page settings-layout">
      <header className="header">
        <div>
          <h1>Settings</h1>
          <p>{current.description}</p>
        </div>
        <div className="settings-header-actions">
          <Link className="settings-link" to="/">
            <ArrowLeft size={14} /> Back
          </Link>
          <ThemeControls />
          <Link className="settings-link" to="/onboarding">
            Onboarding
          </Link>
          <Link className="settings-link" to="/operations">
            Operations
          </Link>
          <Link className="settings-link" to="/">
            Workspaces
          </Link>
        </div>
      </header>
      <div className="settings-shell">
        <nav className="settings-sidebar" aria-label="Settings sections">
          {SECTIONS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={`settings-nav-item ${section === entry.id ? "active" : ""}`}
              onClick={() => setSection(entry.id)}
              aria-current={section === entry.id ? "page" : undefined}
            >
              <span className="settings-nav-icon">{entry.icon}</span>
              <span className="settings-nav-label">{entry.label}</span>
            </button>
          ))}
        </nav>
        <section className="settings-content" aria-labelledby="settings-section-title">
          <div className="settings-section-header">
            <h2 id="settings-section-title">{current.label}</h2>
            <p>{current.description}</p>
          </div>
          {section === "overview" ? (
            <OverviewSection
              providerHealth={state.data?.providerHealth ?? []}
              runtimes={state.data?.runtimes ?? []}
              repoCount={state.data?.repos.length ?? 0}
              mcpEnabled={Boolean(state.data?.mcp.enabled)}
            />
          ) : null}
          {section === "providers" ? <ProvidersPanel providerHealth={state.data?.providerHealth ?? []} /> : null}
          {section === "agents" ? <AgentsPanel runtimes={state.data?.runtimes ?? []} /> : null}
          {section === "scheduled-agents" ? <ScheduledAgentsPanel state={state.data} /> : null}
          {section === "repositories" ? <RepositoriesPanel state={state.data} /> : null}
          {section === "mcp" ? <McpSection mcpEnabled={Boolean(state.data?.mcp.enabled)} /> : null}
          {section === "advanced" ? <StructuredConfig /> : null}
        </section>
      </div>
    </div>
  );
}

function OverviewSection(props: {
  providerHealth: ProviderHealth[];
  runtimes: AgentRuntime[];
  repoCount: number;
  mcpEnabled: boolean;
}) {
  const healthyProviders = props.providerHealth.filter((provider) => provider.status === "healthy").length;
  const totalProviders = props.providerHealth.length;
  const healthyRuntimes = props.runtimes.filter((runtime) => runtime.health === "healthy").length;
  return (
    <div className="settings-stack">
      <div className="overview-grid">
        <OverviewCard
          label="Providers"
          value={`${healthyProviders}/${totalProviders} healthy`}
          ready={healthyProviders > 0}
        />
        <OverviewCard label="Agents" value={`${healthyRuntimes} available`} ready={healthyRuntimes > 0} />
        <OverviewCard label="Repositories" value={`${props.repoCount} registered`} ready={props.repoCount > 0} />
        <OverviewCard label="MCP" value={props.mcpEnabled ? "Enabled" : "Disabled"} ready={props.mcpEnabled} />
      </div>
      <p className="settings-hint">
        Use the sidebar to drill in. Health checks refresh on a 15-second cache and re-run when settings change.
      </p>
    </div>
  );
}

function OverviewCard(props: { label: string; value: string; ready: boolean }) {
  return (
    <div className={`overview-card ${props.ready ? "ready" : "pending"}`}>
      <strong>{props.label}</strong>
      <span>{props.value}</span>
    </div>
  );
}

function McpSection(props: { mcpEnabled: boolean }) {
  // Derived at render time so the example matches *this* cockpit's daemon —
  // important in worktree dev where the port is derived from the worktree path
  // and the systemd main daemon is also running on :4010.
  const mcpUrl =
    typeof window !== "undefined" ? `${window.location.origin}/api/mcp/rpc` : "http://127.0.0.1:4010/api/mcp/rpc";
  const example = JSON.stringify(
    {
      mcpServers: {
        citadel: {
          url: mcpUrl,
        },
      },
    },
    null,
    2,
  );
  return (
    <div className="settings-stack">
      <div className={`overview-card ${props.mcpEnabled ? "ready" : "pending"}`}>
        <strong>MCP</strong>
        <span>{props.mcpEnabled ? "Enabled for local/internal use" : "Disabled"}</span>
      </div>
      <p className="settings-hint">
        Toggle MCP in the Advanced tab. Citadel uses MCP for internal tool wiring; it is not required for the core
        cockpit.
      </p>
      <section className="settings-card">
        <header className="settings-card-header">
          <h3>Client config example</h3>
          <p>Use this shape in MCP clients that accept JSON server definitions.</p>
        </header>
        <pre className="settings-code-example">{example}</pre>
      </section>
    </div>
  );
}
