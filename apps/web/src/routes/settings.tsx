import type { AgentRuntime, ProviderHealth } from "@citadel/contracts";
import { Link } from "@tanstack/react-router";
import { Cable, CheckCircle2, FolderGit2, HeartPulse, Server, Settings as SettingsIcon, Webhook } from "lucide-react";
import { useState } from "react";
import { useStateQuery } from "../app-state.js";
import { ProvidersPanel } from "../settings-providers.js";
import { RepositoriesPanel } from "../settings-repositories.js";
import { RuntimesPanel } from "../settings-runtimes.js";
import { StructuredConfig } from "../structured-config.js";
import { ThemeControls } from "../theme-controls.js";

type SectionId = "overview" | "providers" | "runtimes" | "repositories" | "hooks" | "mcp" | "advanced";

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
  { id: "runtimes", label: "Runtimes", description: "Agent and terminal runtimes", icon: <Server size={14} /> },
  {
    id: "repositories",
    label: "Repositories",
    description: "Registered repos and tracking",
    icon: <FolderGit2 size={14} />,
  },
  { id: "hooks", label: "Hooks", description: "Workspace lifecycle hooks", icon: <Webhook size={14} /> },
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
          {section === "runtimes" ? <RuntimesPanel runtimes={state.data?.runtimes ?? []} /> : null}
          {section === "repositories" ? <RepositoriesPanel state={state.data} /> : null}
          {section === "hooks" ? <HooksSection /> : null}
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
        <OverviewCard label="Runtimes" value={`${healthyRuntimes} available`} ready={healthyRuntimes > 0} />
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

function HooksSection() {
  return (
    <div className="settings-stack">
      <p className="settings-hint">
        Hooks are configured in the Advanced tab today. Per-repo bindings live on each repository's settings page.
      </p>
      <Link to="/" className="settings-link">
        Pick a repository from the navigator to configure its hooks
      </Link>
    </div>
  );
}

function McpSection(props: { mcpEnabled: boolean }) {
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
    </div>
  );
}
