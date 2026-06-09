import * as React from "react";
import { cn } from "../../lib/utils.js";

const baseInputClasses = [
  "block w-full rounded-[7px] border border-[var(--c-line-2)] bg-[var(--c-surface)]",
  "px-2.5 py-1.5 text-sm text-[var(--c-fg-1)]",
  "placeholder:text-[var(--c-fg-4)]",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-action)] focus-visible:ring-offset-1",
  "disabled:cursor-not-allowed disabled:opacity-55",
  "aria-invalid:border-[var(--color-danger)] aria-invalid:focus-visible:ring-[var(--color-danger)]",
].join(" ");

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type = "text", ...props }, ref) => (
    <input ref={ref} type={type} className={cn(baseInputClasses, className)} {...props} />
  ),
);
Input.displayName = "Input";

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, rows = 3, ...props }, ref) => (
    <textarea ref={ref} rows={rows} className={cn(baseInputClasses, "min-h-16 resize-y", className)} {...props} />
  ),
);
Textarea.displayName = "Textarea";
