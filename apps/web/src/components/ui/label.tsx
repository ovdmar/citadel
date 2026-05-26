import type * as React from "react";
import { cn } from "../../lib/utils.js";

// Generic styled <label>. Consumers pass `htmlFor` to associate with their
// control, or wrap a control as a child. `FormField` injects `htmlFor`
// automatically; standalone usages are responsible for supplying it.
export const Label = ({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) => (
  // biome-ignore lint/a11y/noLabelWithoutControl: pass-through Label primitive — association is enforced by FormField or the consumer.
  <label className={cn("block text-xs font-medium text-[var(--c-fg-2)]", className)} {...props} />
);

export const HelpText = ({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) => (
  <p className={cn("text-[11px] text-[var(--c-fg-3)]", className)} {...props} />
);
