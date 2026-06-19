import { X } from "lucide-react";
import type * as React from "react";
import { cn } from "../../lib/utils.js";
import { Badge, type BadgeProps } from "./badge.js";

export interface ChipProps extends Omit<BadgeProps, "dot"> {
  icon?: React.ReactNode;
  onClose?: () => void;
  /** Required aria-label for the close button when onClose is provided. */
  closeAriaLabel?: string;
}

export function Chip({ icon, onClose, closeAriaLabel, children, className, ...rest }: ChipProps) {
  if (onClose && !closeAriaLabel && typeof console !== "undefined") {
    console.warn(
      "Chip: pass `closeAriaLabel` whenever `onClose` is set so the close button is screen-reader-accessible.",
    );
  }
  return (
    <Badge className={cn(className)} {...rest}>
      {icon ? (
        <span data-slot="chip-icon" className="inline-flex items-center">
          {icon}
        </span>
      ) : null}
      {children}
      {onClose ? (
        <button
          type="button"
          data-slot="chip-close"
          aria-label={closeAriaLabel ?? "Remove"}
          onClick={onClose}
          className="-mr-0.5 inline-grid h-4 w-4 place-items-center rounded-full text-current opacity-70 transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-action)]"
        >
          <X size={10} />
        </button>
      ) : null}
    </Badge>
  );
}
