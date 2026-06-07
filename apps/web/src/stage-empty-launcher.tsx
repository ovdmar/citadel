import { Bot, Plus, TerminalSquare } from "lucide-react";
import type { StageLaunchEntry, StageLaunchEntryGroup } from "./stage-launch-actions.js";

export function StageEmptyLauncher(props: {
  targetLabel: string;
  groups: StageLaunchEntryGroup[];
  runtimesCount: number;
  onLaunch: (entry: StageLaunchEntry) => void;
}) {
  return (
    <div className="stage-empty-launcher">
      <div className="stage-empty-header">
        <span className="stage-empty-eyebrow">New session</span>
        <strong>{props.targetLabel}</strong>
      </div>
      {props.groups.map((group) => (
        <section key={group.id} className="stage-empty-section" aria-label={group.label}>
          <div className="stage-empty-section-label">{group.label}</div>
          <div className="stage-launch-grid">
            {group.entries.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={`stage-launch-card ${entry.icon === "terminal" ? "terminal" : "agent"}`}
                title={entry.title}
                disabled={entry.disabled}
                onClick={() => props.onLaunch(entry)}
              >
                <span className="stage-launch-card-icon" aria-hidden>
                  <StageLaunchEntryIcon entry={entry} size={16} />
                </span>
                <span className="stage-launch-card-copy">
                  <strong>{entry.label}</strong>
                  {entry.detail ? (
                    <small className={`stage-launch-detail ${entry.detail}`}>{entry.detail}</small>
                  ) : null}
                </span>
                <span className="stage-launch-card-go" aria-hidden>
                  <Plus size={14} />
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}
      {props.runtimesCount === 0 ? (
        <div className="stage-empty-note">
          No agents configured. <a href="/settings">Open settings</a>
        </div>
      ) : null}
    </div>
  );
}

export function StageLaunchEntryIcon(props: { entry: StageLaunchEntry; size: number }) {
  return props.entry.icon === "terminal" ? <TerminalSquare size={props.size} /> : <Bot size={props.size} />;
}
