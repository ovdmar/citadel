import type { AgentRuntime, RuntimeUsageSummary } from "@citadel/contracts";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { api } from "./api.js";

type RuntimeConfigEntry = {
  id: string;
  showUsageInTopBar?: boolean;
};

type ConfigResponse = { config: { runtimes: RuntimeConfigEntry[] } };

// Tiny low-contrast usage pill rendered in the cockpit top bar, left of the
// Settings icon. One pill per runtime where:
//   - health === "healthy"            (unhealthy runtimes have nothing to fetch)
//   - capabilities.supportsUsage      (only runtimes with a fetcher)
//   - showUsageInTopBar               (operator opted in from Settings)
// Click navigates to /settings so the user can drill into the full breakdown.
export function UsageIndicator(props: { runtimes: AgentRuntime[] }) {
  const configQuery = useQuery({
    queryKey: ["config"],
    queryFn: () => api<ConfigResponse>("/api/config"),
  });
  const configRuntimes = configQuery.data?.config.runtimes ?? [];
  const enabled = props.runtimes.filter((runtime) => {
    if (runtime.health !== "healthy") return false;
    if (!runtime.capabilities.supportsUsage) return false;
    const entry = configRuntimes.find((candidate) => candidate.id === runtime.id);
    return entry?.showUsageInTopBar === true;
  });

  const usageQueries = useQueries({
    queries: enabled.map((runtime) => ({
      queryKey: ["runtime-usage", runtime.id],
      queryFn: () => api<{ usage: RuntimeUsageSummary }>(`/api/runtimes/${runtime.id}/usage`),
      // The daemon caches for 5 min; mirror that here so we don't refetch on
      // every cockpit re-render.
      staleTime: 5 * 60_000,
    })),
  });

  if (enabled.length === 0) return null;
  return (
    <div className="cit-usage-indicator">
      {enabled.map((runtime, index) => {
        const usage = usageQueries[index]?.data?.usage;
        return <UsagePill key={runtime.id} runtime={runtime} usage={usage} />;
      })}
    </div>
  );
}

function UsagePill(props: { runtime: AgentRuntime; usage: RuntimeUsageSummary | undefined }) {
  const summary = props.usage;
  const max = summary?.categories.reduce((acc, category) => Math.max(acc, category.percentUsed), 0) ?? null;
  const label = labelFor(props.runtime);
  const tooltip = buildTooltip(props.runtime.displayName, summary);
  return (
    <Link to="/settings" className="cit-usage-pill" title={tooltip} aria-label={tooltip}>
      <span className="cit-usage-pill-label">{label}</span>
      <span className="cit-usage-pill-value">{max === null ? "—" : `${max}%`}</span>
    </Link>
  );
}

function labelFor(runtime: AgentRuntime): string {
  // Two-or-three letter mark per runtime keeps the pill compact in the top bar.
  switch (runtime.id) {
    case "claude-code":
      return "CC";
    case "codex":
      return "CX";
    default:
      return runtime.id.slice(0, 3).toUpperCase();
  }
}

function buildTooltip(displayName: string, summary: RuntimeUsageSummary | undefined): string {
  if (!summary) return `${displayName} — loading usage…`;
  if (summary.status !== "healthy" || summary.categories.length === 0) {
    return `${displayName}: ${summary.reason ?? "no usage data"}`;
  }
  const lines = summary.categories.map((category) => {
    const sectionPrefix = category.section ? `[${category.section}] ` : "";
    const resetSuffix = category.reset ? ` · resets ${category.reset}` : "";
    return `${sectionPrefix}${category.label}: ${category.percentUsed}% used${resetSuffix}`;
  });
  return `${displayName}\n${lines.join("\n")}`;
}
