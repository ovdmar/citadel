import type { ActivityEvent } from "@citadel/contracts";
import { ExternalLink, Play } from "lucide-react";

export function ActivityRow(props: { event: ActivityEvent }) {
  const output = props.event.hookOutput;
  return (
    <div className="activity-row">
      <span>{props.event.type}</span>
      <p>{props.event.message}</p>
      <time>{new Date(props.event.createdAt).toLocaleTimeString()}</time>
      {output && (output.links.length > 0 || output.actions.length > 0) ? (
        <div className="activity-output">
          {output.links.map((link) => (
            <a key={`${link.kind}:${link.url}`} href={link.url} target="_blank" rel="noreferrer">
              <ExternalLink size={13} /> {link.label}
            </a>
          ))}
          {output.actions.map((action) =>
            action.url ? (
              <a key={action.id} href={action.url} target="_blank" rel="noreferrer">
                <Play size={13} /> {action.label}
              </a>
            ) : (
              <span key={action.id}>
                <Play size={13} /> {action.label}
              </span>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}
