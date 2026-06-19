import type * as React from "react";
import { cn } from "../../lib/utils.js";
import { Button } from "./button.js";

export interface EmptyStateProps {
  icon?: React.ReactNode;
  heading: string;
  description?: React.ReactNode;
  action?: { label: string; onClick: () => void };
  className?: string;
}

export function EmptyState({ icon, heading, description, action, className }: EmptyStateProps) {
  return (
    <div
      data-component="empty-state"
      className={cn("flex flex-col items-center justify-center gap-3 px-6 py-8 text-center", className)}
    >
      {icon ? <div className="text-[var(--c-fg-4)]">{icon}</div> : null}
      <div className="flex flex-col items-center gap-1">
        <div className="text-sm font-semibold text-[var(--c-fg-1)]">{heading}</div>
        {description ? <div className="text-xs text-[var(--c-fg-3)]">{description}</div> : null}
      </div>
      {action ? (
        <Button variant="secondary" size="sm" onClick={action.onClick}>
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}
