import type { AgentRuntime, RuntimeUsageSummary } from "@citadel/contracts";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api.js";
import { formatLabel } from "./labels.js";

const PLATFORM_RUNTIMES: Record<string, { label: string; blurb: string; kind: "agent" | "terminal" }> = {
  "claude-code": {
    label: "Claude Code",
    blurb: "Anthropic's official CLI. Primary agent runtime. Supports resume, prompt, and usage reporting.",
    kind: "agent",
  },
  "cursor-agent": {
    label: "Cursor Agent",
    blurb: "Cursor's headless agent runtime. Prompt-driven, non-interactive friendly.",
    kind: "agent",
  },
  pi: {
    label: "Pi",
    blurb: "Inflection Pi runtime. Prompt-driven conversational agent.",
    kind: "agent",
  },
  shell: {
    label: "Plain Terminal",
    blurb: "Built-in shell terminal. Not an agent — useful when you just need a TTY in the workspace.",
    kind: "terminal",
  },
};

const PLATFORM_IDS = Object.keys(PLATFORM_RUNTIMES);

export function RuntimesPanel(props: { runtimes: AgentRuntime[] }) {
  const platform = props.runtimes.filter((runtime) => PLATFORM_IDS.includes(runtime.id));
  const custom = props.runtimes.filter((runtime) => !PLATFORM_IDS.includes(runtime.id));
  const missingPlatform = PLATFORM_IDS.filter((id) => !platform.some((entry) => entry.id === id));
  return (
    <div className="settings-stack">
      <p className="settings-hint">
        Platform runtimes ship with Citadel. Custom runtimes come from your <code>citadel.config.json</code>; edit them
        in the Advanced tab.
      </p>
      <section className="settings-card">
        <header className="settings-card-header">
          <h3>Platform runtimes</h3>
          <p>Citadel knows how to launch these out of the box. Health is checked via PATH lookup.</p>
        </header>
        <div className="runtime-grid">
          {platform.map((runtime) => (
            <RuntimeRow key={runtime.id} runtime={runtime} platform />
          ))}
          {missingPlatform.map((id) => {
            const meta = PLATFORM_RUNTIMES[id];
            if (!meta) return null;
            return (
              <div key={id} className="runtime-card missing">
                <header>
                  <strong>{meta.label}</strong>
                  <span className={`runtime-kind ${meta.kind}`}>{formatLabel(meta.kind)}</span>
                </header>
                <p>{meta.blurb}</p>
                <small>Not registered in config — add via Advanced or re-init the config.</small>
              </div>
            );
          })}
        </div>
      </section>
      <section className="settings-card">
        <header className="settings-card-header">
          <h3>Custom runtimes</h3>
          <p>Operator-defined runtimes from your config file. Citadel only enforces health and basic capabilities.</p>
        </header>
        {custom.length ? (
          <div className="runtime-grid">
            {custom.map((runtime) => (
              <RuntimeRow key={runtime.id} runtime={runtime} platform={false} />
            ))}
          </div>
        ) : (
          <div className="empty compact">
            No custom runtimes configured. Add them in the Advanced tab if you need bespoke commands.
          </div>
        )}
      </section>
      <p className="settings-hint">Need to add or edit a custom runtime? Use the Advanced tab in the sidebar.</p>
    </div>
  );
}

function RuntimeRow(props: { runtime: AgentRuntime; platform: boolean }) {
  const platformMeta = props.platform ? PLATFORM_RUNTIMES[props.runtime.id] : undefined;
  const kindLabel = platformMeta?.kind ?? (props.runtime.capabilities.supportsPrompt ? "agent" : "terminal");
  return (
    <div className={`runtime-card ${props.runtime.health}`}>
      <header>
        <strong>{platformMeta?.label ?? props.runtime.displayName}</strong>
        <span className={`runtime-kind ${kindLabel}`}>{formatLabel(kindLabel)}</span>
        {props.platform ? (
          <span className="runtime-badge platform">Built-in</span>
        ) : (
          <span className="runtime-badge custom">Custom</span>
        )}
      </header>
      {platformMeta ? <p>{platformMeta.blurb}</p> : null}
      <div className={`runtime-health ${props.runtime.health}`}>
        <span>{formatLabel(props.runtime.health)}</span>
        {props.runtime.healthReason ? <small>{props.runtime.healthReason}</small> : null}
      </div>
      <code className="runtime-command">{[props.runtime.command, ...props.runtime.args].join(" ").trim()}</code>
      {props.runtime.capabilities.supportsUsage ? <RuntimeUsageRow runtimeId={props.runtime.id} /> : null}
    </div>
  );
}

function RuntimeUsageRow(props: { runtimeId: string }) {
  const usage = useQuery({
    queryKey: ["runtime-usage", props.runtimeId],
    queryFn: () => api<{ usage: RuntimeUsageSummary }>(`/api/runtimes/${props.runtimeId}/usage`),
  });
  const summary = usage.data?.usage;
  if (!summary) return <div className="runtime-usage muted">Usage unavailable</div>;
  return (
    <div className={`runtime-usage ${summary.status}`}>
      <span>{summary.source}</span>
      <strong>{summary.remaining ?? summary.spend ?? formatLabel(summary.status)}</strong>
      {summary.reason ? <small>{summary.reason}</small> : null}
    </div>
  );
}
