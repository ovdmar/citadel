import type { AgentRuntime, ProviderHealth, Repo } from "@citadel/contracts";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, Cable, CheckCircle2, ChevronRight, FolderGit2, Moon, Server, Sun, Workflow } from "lucide-react";
import { useEffect, useState } from "react";
import { useStateQuery } from "../app-state.js";
import { ProvidersPanel } from "../settings-providers.js";
import { RepositoriesPanel } from "../settings-repositories.js";
import { AgentsPanel } from "../settings-runtimes.js";

type SectionId = "overview" | "providers" | "agents" | "repositories" | "mcp";

type Section = {
  id: SectionId;
  label: string;
  description: string;
  icon: React.ComponentType<{ size?: number }>;
};

const SECTIONS: Section[] = [
  {
    id: "overview",
    label: "Overview",
    description: "Setup status and health at a glance.",
    icon: CheckCircle2,
  },
  { id: "providers", label: "Integrations", description: "Tickets · Git server · CI.", icon: Cable },
  {
    id: "agents",
    label: "Agent runtimes",
    description: "CLIs Citadel can launch in a workspace.",
    icon: Server,
  },
  {
    id: "repositories",
    label: "Repositories",
    description: "Registered repos and tracking.",
    icon: FolderGit2,
  },
  { id: "mcp", label: "MCP", description: "Model Context Protocol servers Citadel exposes to agents.", icon: Workflow },
];

export function SettingsView() {
  const state = useStateQuery();
  const [section, setSection] = useState<SectionId>("overview");

  const data = state.data;
  const current = SECTIONS.find((entry) => entry.id === section) ?? SECTIONS[0];

  return (
    <div className="set-app">
      <header className="set-topbar">
        <div className="set-brand">
          <Link to="/" className="set-back" aria-label="Back to cockpit">
            <span className="set-back-icon">
              <ArrowLeft size={13} />
            </span>
            <span className="set-back-text">
              <span className="set-back-eyebrow">Citadel</span>
              <span className="set-back-label">Cockpit</span>
            </span>
          </Link>
          <span className="set-brand-sep" aria-hidden>
            ›
          </span>
          <div className="set-brand-text">
            <div className="set-brand-name">Settings</div>
            <div className="set-brand-crumb">{current?.label ?? "Overview"}</div>
          </div>
        </div>

        <div />

        <div className="set-top-right">
          <ThemeToggle />
        </div>
      </header>

      <div className="set-main">
        <nav className="set-nav" aria-label="Settings sections">
          <div className="set-nav-head">
            <div className="set-nav-eyebrow">Citadel</div>
            <div className="set-nav-title">Settings</div>
          </div>
          <div className="set-nav-list">
            {SECTIONS.map((entry) => {
              const Icon = entry.icon;
              return (
                <button
                  key={entry.id}
                  type="button"
                  className={`set-nav-item ${section === entry.id ? "is-active" : ""}`}
                  onClick={() => setSection(entry.id)}
                  aria-current={section === entry.id ? "page" : undefined}
                >
                  <Icon size={15} />
                  <span>{entry.label}</span>
                </button>
              );
            })}
          </div>
        </nav>

        <main className="set-content">
          {section === "overview" ? (
            <Overview
              providerHealth={data?.providerHealth ?? []}
              runtimes={data?.runtimes ?? []}
              repos={data?.repos ?? []}
              mcpEnabled={Boolean(data?.mcp.enabled)}
              onNavigate={setSection}
            />
          ) : null}
          {section === "providers" ? (
            <>
              <PageHead title="Integrations" sub="Tickets · Git server · CI." />
              <ProvidersPanel providerHealth={data?.providerHealth ?? []} />
            </>
          ) : null}
          {section === "agents" ? (
            <>
              <PageHead
                title="Agent runtimes"
                sub="CLIs Citadel can launch in a workspace."
                help="Built-in runtimes are first-class presets Citadel knows by name (and tests via PATH/auth). Custom runtimes are any extra command you want to expose to workspaces — they live in the same list."
              />
              <AgentsPanel runtimes={data?.runtimes ?? []} />
            </>
          ) : null}
          {section === "repositories" ? (
            <>
              <PageHead
                title="Repositories"
                sub="Registered repos and tracking."
                help="Removing tracking preserves the local repo and worktrees on disk — Citadel only forgets about them. Each repo has its own hook bindings inside its Repo settings."
              />
              <RepositoriesPanel state={data} />
            </>
          ) : null}
          {section === "mcp" ? (
            <>
              <PageHead title="MCP servers" sub="Model Context Protocol servers Citadel exposes to agents." />
              <McpSection mcpEnabled={Boolean(data?.mcp.enabled)} />
            </>
          ) : null}
        </main>
      </div>
    </div>
  );
}

function PageHead(props: { title: string; sub?: string; help?: string }) {
  return (
    <div className="set-page-head">
      <div className="set-page-title">{props.title}</div>
      {props.sub ? <div className="set-page-sub">{props.sub}</div> : null}
      {props.help ? <div className="set-page-help">{props.help}</div> : null}
    </div>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useState(() => localStorage.getItem("citadel.theme") || "system");
  useEffect(() => {
    localStorage.setItem("citadel.theme", theme);
    if (theme === "system") {
      delete document.documentElement.dataset.theme;
    } else {
      document.documentElement.dataset.theme = theme;
    }
  }, [theme]);

  // Light <-> Dark cycle (system stays accessible via the existing CockpitTools menu).
  const isDark = theme === "dark";
  const toggle = () => setTheme(isDark ? "light" : "dark");
  return (
    <button
      type="button"
      className="set-icon-btn"
      onClick={toggle}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      aria-label="Toggle theme"
    >
      {isDark ? <Sun size={15} /> : <Moon size={15} />}
    </button>
  );
}

// ─── Overview ──────────────────────────────────────────────────────────────
// Wires real state into the summary-card layout from the design.

type Status = "ok" | "bad" | "warn" | "active" | "idle" | "paused";

type SumItem = { name: string; meta: string; status: Status };
type SumCard = {
  id: string;
  label: string;
  target: SectionId | null;
  items: SumItem[];
};

const STATUS_PILL: Record<Status, { cls: string; label: string }> = {
  ok: { cls: "set-pill-ok", label: "Healthy" },
  bad: { cls: "set-pill-bad", label: "Unavail." },
  warn: { cls: "set-pill-warn", label: "Stale" },
  active: { cls: "set-pill-warn", label: "Active" },
  idle: { cls: "set-pill-mute", label: "Idle" },
  paused: { cls: "set-pill-mute", label: "Paused" },
};

function Overview(props: {
  providerHealth: ProviderHealth[];
  runtimes: AgentRuntime[];
  repos: Repo[];
  mcpEnabled: boolean;
  onNavigate: (id: SectionId) => void;
}) {
  const cards: SumCard[] = [
    {
      id: "providers",
      label: "Integrations",
      target: "providers",
      items: props.providerHealth.map((entry) => ({
        name: entry.displayName,
        meta: entry.reason ?? formatProviderKind(entry.kind),
        status: providerStatusToTone(entry.status),
      })),
    },
    {
      id: "agents",
      label: "Agent runtimes",
      target: "agents",
      items: props.runtimes.map((runtime) => ({
        name: runtime.displayName,
        meta: runtime.healthReason ?? runtime.command,
        status: providerStatusToTone(runtime.health),
      })),
    },
    {
      id: "repos",
      label: "Repositories",
      target: "repositories",
      items: props.repos.map((repo) => ({
        name: repo.name,
        meta: repo.rootPath,
        status: "active" as Status,
      })),
    },
  ];

  const attention = buildAttention(props);

  return (
    <>
      <PageHead title="Overview" sub="Setup status and health at a glance." />
      <div className="set-sum-grid">
        {cards.map((card) => (
          <OverviewCard key={card.id} card={card} onNavigate={props.onNavigate} />
        ))}
      </div>

      {attention.length > 0 ? (
        <div className="set-card set-section" style={{ marginTop: 18 }}>
          <div className="set-section-head" style={{ paddingBottom: 4 }}>
            <span className="set-section-eyebrow">Needs attention</span>
            <span className="set-section-count">{attention.length}</span>
          </div>
          <div className="set-section-sub" style={{ paddingTop: 0 }}>
            Things Citadel can keep running without, but should be resolved.
          </div>
          <div className="set-attn-list">
            {attention.map((item) => (
              <div key={`${item.tone}:${item.title}`} className={`set-attn set-attn--${item.tone}`}>
                <span className="set-attn-dot" />
                <div className="set-attn-text">
                  <div className="set-attn-title">{item.title}</div>
                  <div className="set-attn-detail">{item.detail}</div>
                </div>
                <button type="button" className="set-btn" onClick={() => item.target && props.onNavigate(item.target)}>
                  {item.action} →
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}

function OverviewCard(props: { card: SumCard; onNavigate: (id: SectionId) => void }) {
  const { card } = props;
  const [expanded, setExpanded] = useState(false);
  const total = card.items.length;
  const cap = expanded ? total : Math.min(3, total);
  const visible = card.items.slice(0, cap);
  const hidden = total - cap;
  return (
    <div className="set-sum-card">
      <button
        type="button"
        className="set-sum-head"
        onClick={() => card.target && props.onNavigate(card.target)}
        title={card.target ? `Open ${card.label}` : undefined}
      >
        <span className="set-sum-eyebrow">{card.label}</span>
        <span className="set-sum-count">{total}</span>
        <span className="set-sum-arrow">
          <ChevronRight size={12} />
        </span>
      </button>
      {total === 0 ? (
        <div className="set-sum-empty">Nothing here yet.</div>
      ) : (
        <div className="set-sum-list">
          {visible.map((item) => {
            const pill = STATUS_PILL[item.status];
            return (
              <button
                key={`${item.status}:${item.name}`}
                type="button"
                className="set-sum-row"
                onClick={() => card.target && props.onNavigate(card.target)}
                title={`Open ${item.name} in ${card.label}`}
              >
                <span className={`set-sum-dot set-sum-dot--${item.status}`} />
                <span className="set-sum-row-text">
                  <span className="set-sum-row-name">{item.name}</span>
                  <span className="set-sum-row-meta">{item.meta}</span>
                </span>
                <span className={`set-pill ${pill.cls}`}>{pill.label}</span>
              </button>
            );
          })}
        </div>
      )}
      {hidden > 0 || expanded ? (
        <button type="button" className="set-sum-more" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show less" : `See ${hidden} more`}
        </button>
      ) : null}
    </div>
  );
}

function providerStatusToTone(status: ProviderHealth["status"]): Status {
  if (status === "healthy") return "ok";
  if (status === "degraded") return "warn";
  if (status === "unavailable") return "bad";
  return "idle";
}

function formatProviderKind(kind: ProviderHealth["kind"]): string {
  switch (kind) {
    case "version-control":
      return "Git";
    case "pull-request":
      return "PRs";
    case "ci":
      return "CI";
    case "issue-tracker":
      return "Tickets";
    case "usage":
      return "Usage";
    case "notification":
      return "Notifications";
    default:
      return kind;
  }
}

type AttentionItem = {
  tone: "bad" | "warn";
  title: string;
  detail: string;
  action: string;
  target: SectionId | null;
};

function buildAttention(props: {
  providerHealth: ProviderHealth[];
  runtimes: AgentRuntime[];
}): AttentionItem[] {
  const items: AttentionItem[] = [];

  for (const runtime of props.runtimes) {
    if (runtime.health === "unavailable") {
      items.push({
        tone: "bad",
        title: `${runtime.displayName} is unavailable`,
        detail: runtime.healthReason ?? `Command \`${runtime.command}\` could not be verified. Check PATH or auth.`,
        action: "Configure",
        target: "agents",
      });
    } else if (runtime.health === "degraded") {
      items.push({
        tone: "warn",
        title: `${runtime.displayName} is degraded`,
        detail: runtime.healthReason ?? "Health check reported a partial failure.",
        action: "Inspect",
        target: "agents",
      });
    }
  }

  for (const provider of props.providerHealth) {
    if (provider.status === "unavailable") {
      items.push({
        tone: "bad",
        title: `${provider.displayName} is disconnected`,
        detail: provider.reason ?? "Provider auth could not be verified.",
        action: "Configure",
        target: "providers",
      });
    } else if (provider.status === "degraded") {
      items.push({
        tone: "warn",
        title: `${provider.displayName} is degraded`,
        detail: provider.reason ?? "Provider returned partial data.",
        action: "Inspect",
        target: "providers",
      });
    }
  }

  return items;
}

// ─── MCP section ───────────────────────────────────────────────────────────
function McpSection(props: { mcpEnabled: boolean }) {
  const mcpUrl =
    typeof window !== "undefined" ? `${window.location.origin}/api/mcp/rpc` : "http://127.0.0.1:4010/api/mcp/rpc";
  const example = JSON.stringify(
    {
      mcpServers: {
        citadel: { url: mcpUrl },
      },
    },
    null,
    2,
  );
  return (
    <div className="set-card set-section">
      <div className="set-section-head">
        <span className="set-section-eyebrow">Citadel MCP</span>
        <span className={`set-pill ${props.mcpEnabled ? "set-pill-ok" : "set-pill-mute"}`}>
          <span className="set-pill-dot" />
          {props.mcpEnabled ? "Enabled" : "Disabled"}
        </span>
      </div>
      <div className="set-section-sub">
        Citadel exposes its own MCP server at <span className="set-mono">{mcpUrl}</span>. Toggle it from the Advanced
        tab. Citadel uses MCP for internal tool wiring; it is not required for the core cockpit.
      </div>
      <pre className="set-code-block">{example}</pre>
    </div>
  );
}
