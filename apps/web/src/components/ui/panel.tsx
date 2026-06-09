import * as React from "react";
import { cn } from "../../lib/utils.js";

// Panel: a labelled container used by the cockpit's right inspector
// (Stats, Deployed apps, etc.) and the dashboard sections. Composes from
// PanelHeader + PanelTitle + PanelBody + PanelFooter. The header uses
// elevated surface tokens; the title renders the small uppercase label
// shape B.8 #12 calls out.

export const Panel = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <section
      ref={ref}
      data-component="panel"
      className={cn(
        "flex flex-col overflow-hidden rounded-[10px] border border-[var(--c-line-2)] bg-[var(--c-surface)]",
        className,
      )}
      {...props}
    />
  ),
);
Panel.displayName = "Panel";

export const PanelHeader = React.forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement>>(
  ({ className, ...props }, ref) => (
    <header
      ref={ref}
      data-slot="panel-header"
      className={cn(
        "flex items-center gap-2 border-b border-[var(--c-line-2)] bg-[var(--c-elev)] px-3 py-2",
        className,
      )}
      {...props}
    />
  ),
);
PanelHeader.displayName = "PanelHeader";

export function PanelTitle({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="panel-title"
      className={cn("text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--c-fg-4)]", className)}
      {...props}
    />
  );
}

export const PanelBody = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} data-slot="panel-body" className={cn("flex-1 overflow-auto p-3", className)} {...props} />
  ),
);
PanelBody.displayName = "PanelBody";

export const PanelFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      data-slot="panel-footer"
      className={cn("border-t border-[var(--c-line-2)] bg-[var(--c-elev)] px-3 py-2", className)}
      {...props}
    />
  ),
);
PanelFooter.displayName = "PanelFooter";
