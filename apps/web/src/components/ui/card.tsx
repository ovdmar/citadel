import * as React from "react";
import { cn } from "../../lib/utils.js";

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {}

export const Card = React.forwardRef<HTMLDivElement, CardProps>(({ className, ...props }, ref) => {
  return (
    <div
      ref={ref}
      data-component="card"
      className={cn(
        "rounded-[10px] border border-[var(--c-line-2)] bg-[var(--c-card)] p-3 shadow-[var(--sh-card)]",
        className,
      )}
      {...props}
    />
  );
});
Card.displayName = "Card";
