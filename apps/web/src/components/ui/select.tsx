import * as React from "react";
import { cn } from "../../lib/utils.js";

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, children, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        "block w-full appearance-none rounded-[7px] border border-[var(--c-line-2)] bg-[var(--c-surface)]",
        "bg-[image:linear-gradient(45deg,transparent_50%,currentColor_50%),linear-gradient(135deg,currentColor_50%,transparent_50%)]",
        "bg-[size:5px_5px,5px_5px]",
        "bg-[position:calc(100%-10px)_55%,calc(100%-5px)_55%]",
        "bg-no-repeat",
        "px-2.5 py-1.5 pr-7 text-sm text-[var(--c-fg-1)]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-action)] focus-visible:ring-offset-1",
        "disabled:cursor-not-allowed disabled:opacity-55",
        "aria-invalid:border-[var(--color-danger)] aria-invalid:focus-visible:ring-[var(--color-danger)]",
        className,
      )}
      {...props}
    >
      {children}
    </select>
  ),
);
Select.displayName = "Select";
